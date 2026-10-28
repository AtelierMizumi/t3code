import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
  type ZCodeSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { normalizeModelSlug } from "@t3tools/shared/model";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type ZCodeAdapterShape } from "../Services/ZCodeAdapter.ts";
import {
  handleBuiltinZcodeServerRequest,
  mapRuntimeModeToZcodeMode,
  startZcodeProtocolClient,
  zcodeCreateSession,
  zcodeResumeSession,
  type ZcodeProtocolClient,
  type ZcodeServerRequest,
  type ZcodeSessionEvent,
} from "../zcodeRuntime.ts";
import { readZcodeDesktopPlan } from "../zcodeDesktopAuth.ts";

const PROVIDER = ProviderDriverKind.make("zcode");
const ZCODE_RESUME_VERSION = 1 as const;

export interface ZCodeAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly zcodeRequestId: number | string;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly options: ReadonlyArray<{ readonly optionId: string; readonly kind: string }>;
}

interface PendingUserInput {
  readonly zcodeRequestId: number | string;
  readonly resolution: Deferred.Deferred<
    | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
    | { readonly _tag: "cancelled" }
  >;
}

interface ZcodeSessionContext {
  readonly threadId: ThreadId;
  readonly zcodeSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly client: ZcodeProtocolClient;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  interruptedTurnIds: Set<TurnId>;
  currentModelId: string | undefined;
  currentProviderId: string | undefined;
  assistantItemStarted: boolean;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseZcodeResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ZCODE_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function resolveZcodeModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "GLM-5.3";
  const slash = base.lastIndexOf("/");
  const modelId = slash >= 0 ? base.slice(slash + 1) : base;
  return normalizeModelSlug(modelId, PROVIDER) ?? "GLM-5.3";
}

function toolItemType(
  toolName: string | undefined,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  const name = toolName?.toLowerCase() ?? "";
  if (name.includes("bash") || name.includes("shell") || name.includes("exec")) {
    return "command_execution";
  }
  if (name.includes("edit") || name.includes("write") || name.includes("apply")) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

function permissionOptions(
  params: unknown,
): ReadonlyArray<{ readonly optionId: string; readonly kind: string }> {
  if (!isRecord(params) || !Array.isArray(params.options)) return [];
  return params.options.flatMap((option) => {
    if (!isRecord(option) || typeof option.optionId !== "string") return [];
    return [{ optionId: option.optionId, kind: String(option.kind ?? "") }];
  });
}

function selectPermissionOptionId(
  options: ReadonlyArray<{ readonly optionId: string; readonly kind: string }>,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return (
    options.find((option) => option.kind === kind)?.optionId ??
    options.find((option) =>
      decision === "reject"
        ? option.kind.includes("deny") || option.kind.includes("reject")
        : option.kind.includes("allow"),
    )?.optionId ??
    options[0]?.optionId
  );
}

function userInputQuestions(params: unknown): ReadonlyArray<UserInputQuestion> {
  if (!isRecord(params)) return [];
  if (Array.isArray(params.questions)) {
    return params.questions.flatMap((question, index) => {
      if (!isRecord(question) || typeof question.question !== "string") return [];
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) => {
            if (!isRecord(option)) return [];
            const label =
              typeof option.label === "string" ? option.label : String(option.value ?? "OK");
            return [
              {
                label,
                description: typeof option.description === "string" ? option.description : label,
              },
            ];
          })
        : [{ label: "OK", description: "Continue" }];
      return [
        {
          id: `q_${index}`,
          header: "Question",
          question: question.question,
          multiSelect: question.multiSelect === true,
          options: options.length > 0 ? options : [{ label: "OK", description: "Continue" }],
        } satisfies UserInputQuestion,
      ];
    });
  }
  if (isRecord(params.schema) && params.schema.interaction === "plan_approval") {
    const plan =
      isRecord(params.input) && typeof params.input.plan === "string"
        ? params.input.plan
        : "Approve this plan?";
    return [
      {
        id: "plan",
        header: "Plan",
        question: plan,
        multiSelect: false,
        options: [
          { label: "Approve", description: "Approve this plan" },
          { label: "Reject", description: "Reject this plan" },
        ],
      },
    ];
  }
  return [];
}

export function makeZcodeAdapter(zcodeSettings: ZCodeSettings, options?: ZCodeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("zcode");
    const crypto = yield* Crypto.Crypto;
    const sessions = new Map<ThreadId, ZcodeSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const runtimeContext = yield* Effect.context<Crypto.Crypto | Clock.Clock>();
    const runFork = Effect.runForkWith(runtimeContext);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate ZCode runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const handleZcodeEvent = (ctx: ZcodeSessionContext, event: ZcodeSessionEvent) =>
      Effect.gen(function* () {
        if (event.sessionId !== ctx.zcodeSessionId) return;
        const turnId = ctx.activeTurnId;
        if (turnId !== undefined && ctx.interruptedTurnIds.has(turnId)) return;
        const stamp = yield* makeEventStamp();
        const payload = isRecord(event.payload) ? event.payload : {};

        switch (event.type) {
          case "turn.started":
            return;
          case "model.streaming": {
            if (!turnId) return;
            const kind = typeof payload.kind === "string" ? payload.kind : "";
            const delta = typeof payload.delta === "string" ? payload.delta : "";
            if (kind === "reasoning_delta" && delta) {
              yield* offerRuntimeEvent({
                type: "content.delta",
                ...stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: { streamKind: "reasoning_text", delta },
                raw: { source: "zcode.protocol.event", method: event.type, payload: event.payload },
              });
              return;
            }
            if ((kind === "text_delta" || kind === "") && delta) {
              if (!ctx.assistantItemStarted) {
                ctx.assistantItemStarted = true;
                yield* offerRuntimeEvent({
                  type: "item.started",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(`assistant-${turnId}`),
                  payload: { itemType: "assistant_message", status: "inProgress" },
                });
              }
              yield* offerRuntimeEvent({
                type: "content.delta",
                ...stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                itemId: RuntimeItemId.make(`assistant-${turnId}`),
                payload: { streamKind: "assistant_text", delta },
                raw: { source: "zcode.protocol.event", method: event.type, payload: event.payload },
              });
            }
            return;
          }
          case "tool.updated": {
            if (!turnId) return;
            const toolCallId =
              typeof payload.toolCallId === "string" ? payload.toolCallId : yield* randomUUIDv4;
            const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
            const kind = typeof payload.kind === "string" ? payload.kind : "started";
            const completed = kind === "result" || kind === "error" || kind === "batch";
            yield* offerRuntimeEvent({
              type: completed
                ? "item.completed"
                : kind === "scheduled"
                  ? "item.started"
                  : "item.updated",
              ...stamp,
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              itemId: RuntimeItemId.make(toolCallId),
              payload: {
                itemType: toolItemType(toolName),
                status: kind === "error" ? "failed" : completed ? "completed" : "inProgress",
                title: toolName,
                ...(isRecord(payload.input) ? { data: payload.input } : {}),
              },
              raw: { source: "zcode.protocol.event", method: event.type, payload: event.payload },
            });
            return;
          }
          case "turn.completed":
          case "turn.failed":
          case "turn.terminal": {
            if (!turnId) return;
            const failed = event.type === "turn.failed";
            const { activeTurnId: _done, ...readySession } = ctx.session;
            ctx.activeTurnId = undefined;
            ctx.assistantItemStarted = false;
            ctx.session = {
              ...readySession,
              status: "ready",
              updatedAt: yield* nowIso,
            };
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...stamp,
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: {
                state: failed ? "failed" : "completed",
                ...(failed
                  ? {
                      errorMessage:
                        isRecord(payload.error) && typeof payload.error.message === "string"
                          ? payload.error.message
                          : "ZCode turn failed.",
                    }
                  : {}),
              },
              raw: { source: "zcode.protocol.event", method: event.type, payload: event.payload },
            });
            return;
          }
          default:
            return;
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to process ZCode session event.", { cause, type: event.type }),
        ),
      );

    const handleServerRequest = (ctx: ZcodeSessionContext, request: ZcodeServerRequest) =>
      Effect.gen(function* () {
        if (handleBuiltinZcodeServerRequest(ctx.client, request)) {
          return;
        }
        if (request.method === "interaction/requestPermission") {
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const runtimeRequestId = RuntimeRequestId.make(requestId);
          const decision = yield* Deferred.make<ProviderApprovalDecision>();
          const options = permissionOptions(request.params);
          ctx.pendingApprovals.set(requestId, {
            zcodeRequestId: request.id,
            decision,
            options,
          });
          const params = isRecord(request.params) ? request.params : {};
          yield* offerRuntimeEvent({
            type: "request.opened",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: runtimeRequestId,
            payload: {
              requestType: "exec_command_approval",
              detail:
                typeof params.reason === "string"
                  ? params.reason
                  : String(params.toolName ?? "tool"),
              args: params.input ?? params,
            },
            raw: {
              source: "zcode.protocol.event",
              method: request.method,
              payload: request.params,
            },
          });
          return;
        }
        if (request.method === "interaction/requestUserInput") {
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const runtimeRequestId = RuntimeRequestId.make(requestId);
          const resolution = yield* Deferred.make<
            | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
            | { readonly _tag: "cancelled" }
          >();
          ctx.pendingUserInputs.set(requestId, {
            zcodeRequestId: request.id,
            resolution,
          });
          yield* offerRuntimeEvent({
            type: "user-input.requested",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: runtimeRequestId,
            payload: { questions: userInputQuestions(request.params) },
            raw: {
              source: "zcode.protocol.event",
              method: request.method,
              payload: request.params,
            },
          });
          return;
        }
        ctx.client.reply(request.id, {});
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to handle ZCode server request.", {
            cause,
            method: request.method,
          }),
        ),
      );

    const stopSessionInternal = (ctx: ZcodeSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        for (const pending of ctx.pendingApprovals.values()) {
          yield* Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore);
        }
        for (const pending of ctx.pendingUserInputs.values()) {
          yield* Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore);
        }
        sessions.delete(ctx.threadId);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...sessions.values()], stopSessionInternal, {
        concurrency: "unbounded",
        discard: true,
      }),
    );

    const startSession: ZCodeAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const cwd = input.cwd.trim();
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const client = yield* startZcodeProtocolClient({
            binaryPath: zcodeSettings.binaryPath,
            cwd,
            environment: options?.environment,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const ctxHolder: { current: ZcodeSessionContext | undefined } = { current: undefined };
          client.setEventHandler((event) => {
            const ctx = ctxHolder.current;
            if (!ctx) return;
            runFork(handleZcodeEvent(ctx, event));
          });
          client.setServerRequestHandler((request) => {
            const ctx = ctxHolder.current;
            if (!ctx) {
              handleBuiltinZcodeServerRequest(client, request);
              return;
            }
            if (handleBuiltinZcodeServerRequest(client, request)) return;
            runFork(handleServerRequest(ctx, request));
          });

          const desktopPlan = readZcodeDesktopPlan(options?.environment);
          const requestedModel = resolveZcodeModelId(input.modelSelection?.model);
          const resumeSessionId = parseZcodeResume(input.resumeCursor)?.sessionId;
          const created = yield* (
            resumeSessionId
              ? zcodeResumeSession(client, { cwd, sessionId: resumeSessionId })
              : zcodeCreateSession(client, {
                  cwd,
                  mode: mapRuntimeModeToZcodeMode(input.runtimeMode, undefined),
                  modelId: requestedModel,
                  providerId: desktopPlan?.providerId,
                })
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          if (created.modelId && created.modelId !== requestedModel) {
            yield* Effect.tryPromise({
              try: () =>
                client.request("session/setModel", {
                  sessionId: created.sessionId,
                  model: {
                    modelId: requestedModel,
                    ...(desktopPlan?.providerId ? { providerId: desktopPlan.providerId } : {}),
                  },
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/setModel",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            }).pipe(Effect.ignore);
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: created.modelId ?? requestedModel,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: ZCODE_RESUME_VERSION,
              sessionId: created.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };
          const ctx: ZcodeSessionContext = {
            threadId: input.threadId,
            zcodeSessionId: created.sessionId,
            session,
            scope: sessionScope,
            client,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            currentModelId: created.modelId ?? requestedModel,
            currentProviderId: created.providerId ?? desktopPlan?.providerId,
            assistantItemStarted: false,
            stopped: false,
          };
          ctxHolder.current = ctx;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: created.raw },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "ZCode session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: created.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ZCodeAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const turnId = ctx.activeTurnId ?? TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;
          ctx.assistantItemStarted = false;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };
          if (input.interactionMode === "plan") {
            yield* Effect.tryPromise({
              try: () =>
                ctx.client.request("session/setMode", {
                  sessionId: ctx.zcodeSessionId,
                  mode: "plan",
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/setMode",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            }).pipe(Effect.ignore);
          }
          const requestedModel = input.modelSelection?.model
            ? resolveZcodeModelId(input.modelSelection.model)
            : undefined;
          if (requestedModel && requestedModel !== ctx.currentModelId) {
            yield* Effect.tryPromise({
              try: () =>
                ctx.client.request("session/setModel", {
                  sessionId: ctx.zcodeSessionId,
                  model: {
                    modelId: requestedModel,
                    ...(ctx.currentProviderId ? { providerId: ctx.currentProviderId } : {}),
                  },
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/setModel",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            }).pipe(Effect.ignore);
            ctx.currentModelId = requestedModel;
            ctx.session = { ...ctx.session, model: requestedModel };
          }

          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: ctx.currentModelId ? { model: ctx.currentModelId } : {},
          });

          yield* Effect.tryPromise({
            try: () =>
              ctx.client.request("session/send", {
                sessionId: ctx.zcodeSessionId,
                content: input.input ?? "",
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/send",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });

          ctx.turns = [...ctx.turns, { id: turnId, items: [{ prompt: input.input }] }];
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );

    const interruptTurn: ZCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) return;
        const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
        if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
          return;
        }
        const interruptedTurnId = turnId ?? activeTurnId;
        if (interruptedTurnId !== undefined) {
          ctx.interruptedTurnIds.add(interruptedTurnId);
        }
        ctx.client.notify("session/stop", { sessionId: ctx.zcodeSessionId });
        if (interruptedTurnId) {
          const { activeTurnId: _cleared, ...readySession } = ctx.session;
          ctx.activeTurnId = undefined;
          ctx.session = { ...readySession, status: "ready", updatedAt: yield* nowIso };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: interruptedTurnId,
            payload: { state: "cancelled" },
          });
        }
      });

    const respondToRequest: ZCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) return;
        ctx.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision).pipe(Effect.ignore);
        if (decision === "cancel") {
          ctx.client.reply(pending.zcodeRequestId, {
            outcome: { outcome: "cancelled" },
          });
        } else {
          const optionId = selectPermissionOptionId(pending.options, decision);
          ctx.client.reply(pending.zcodeRequestId, {
            outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
          });
        }
        yield* offerRuntimeEvent({
          type: "request.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: ctx.activeTurnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: "exec_command_approval", decision },
        });
      });

    const respondToUserInput: ZCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) return;
        ctx.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers }).pipe(
          Effect.ignore,
        );
        ctx.client.reply(pending.zcodeRequestId, { answers });
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: ctx.activeTurnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      });

    const stopSession: ZCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        yield* stopSessionInternal(ctx);
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: ctx.turns }))),
      rollbackThread: (threadId) =>
        requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: ctx.turns }))),
      stopAll: () =>
        Effect.forEach([...sessions.values()], stopSessionInternal, {
          concurrency: "unbounded",
          discard: true,
        }),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ZCodeAdapterShape;
  });
}
