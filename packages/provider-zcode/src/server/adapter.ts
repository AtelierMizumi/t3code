import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import { ZcodeSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";

import {
  buildZcodeProviderConfigEnv,
  readZcodeDesktopPlan,
  ZCODE_API_TEMPLATE_PROVIDER_ID,
} from "./desktopAuth.ts";
import {
  handleBuiltinZcodeServerRequest,
  makeZcodeRpcConnection,
  mapRuntimeModeToZcodeMode,
  parseZcodeServerRequest,
  parseZcodeSessionEvent,
  rejectUnhandledZcodeServerRequest,
  resolveZcodeModelSlug,
  zcodeCreateSession,
  zcodeRecordField,
  zcodeRecordString,
  zcodeResumeSession,
  type ZcodeRpcConnection,
  type ZcodeServerRequest,
  type ZcodeSessionEvent,
} from "./rpc.ts";

export const ZCODE_PROVIDER = ProviderDriverKind.make("zcode");
const DRIVER_KIND = ZCODE_PROVIDER;

const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZcodeSettings)({});

/**
 * Every flag reflects what the ZCode app-server protocol really does today:
 * streaming text and tool updates, command approval + structured questions,
 * plan mode as a session mode (no proposed-plan card), no rollback/fork.
 */
const ZcodeProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ZcodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ZcodeSettings;
  readonly environment: NodeJS.ProcessEnv;
}

interface PendingZcodeInteraction {
  readonly kind: "permission" | "user_input";
  readonly zcodeRequestId: number | string;
  readonly nativeParams: unknown;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  turnItem: OrchestrationV2TurnItem;
}

interface ZcodeThreadState {
  providerThread: OrchestrationV2ProviderThread;
  zcodeSessionId: string;
  baselineModelId: string | null;
  appliedModelId: string | null;
  activeTurn: ActiveZcodeTurn | null;
  turns: Array<OrchestrationV2ProviderTurn>;
  messages: Array<OrchestrationV2ConversationMessage>;
  requests: Array<OrchestrationV2RuntimeRequest>;
}

interface ActiveZcodeTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly turnMessages: Array<OrchestrationV2ConversationMessage>;
  nextItemOrdinal: number;
  assistantItemId: string | null;
  assistantText: string;
  reasoningText: string;
  nativeTurnStarted: boolean;
}

function providerRef(nativeId: string, strength: "strong" | "weak" = "strong") {
  return { driver: DRIVER_KIND, nativeId, strength };
}

function permissionOptions(params: unknown): ReadonlyArray<{ optionId: string; kind: string }> {
  if (!Predicate.isObject(params) || !Array.isArray(params.options)) return [];
  return params.options.flatMap((option) => {
    if (!Predicate.isObject(option) || typeof option.optionId !== "string") return [];
    return [{ optionId: option.optionId, kind: String(option.kind ?? "") }];
  });
}

export function selectZcodePermissionOptionId(
  options: ReadonlyArray<{ readonly optionId: string; readonly kind: string }>,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession" || decision === "acceptAlways"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return options.find((option) => option.kind.trim().toLowerCase() === kind)?.optionId;
}

function userInputQuestions(
  params: unknown,
  nativeRequestId: string,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  if (!Predicate.isObject(params)) return [];
  if (Array.isArray(params.questions)) {
    return params.questions.flatMap((question, index) => {
      if (!Predicate.isObject(question) || typeof question.question !== "string") return [];
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) => {
            if (!Predicate.isObject(option)) return [];
            const label =
              typeof option.label === "string" ? option.label : String(option.value ?? "OK");
            return [
              {
                label,
                description: typeof option.description === "string" ? option.description : label,
                ...(typeof option.value === "string" ? { value: option.value } : {}),
              },
            ];
          })
        : [];
      return [
        {
          id: `${nativeRequestId}:q${index}`,
          header: "Question",
          question: question.question,
          multiSelect: question.multiSelect === true,
          options: options.length > 0 ? options : [{ label: "OK", description: "Continue" }],
        } satisfies OrchestrationV2UserInputQuestion,
      ];
    });
  }
  if (Predicate.isObject(params.schema) && params.schema.interaction === "plan_approval") {
    const plan =
      Predicate.isObject(params.input) && typeof params.input.plan === "string"
        ? params.input.plan
        : "Approve this plan?";
    return [
      {
        id: `${nativeRequestId}:plan`,
        header: "Plan",
        question: plan,
        multiSelect: false,
        options: [
          { label: "Approve", description: "Approve this plan" },
          { label: "Reject", description: "Reject this plan" },
        ],
      } satisfies OrchestrationV2UserInputQuestion,
    ];
  }
  return [];
}

type ZcodeToolShape = "command_execution" | "file_change" | "dynamic_tool";

export function zcodeToolShape(toolName: string): ZcodeToolShape {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "bash" || normalized === "command" || normalized.includes("command")) {
    return "command_execution";
  }
  if (normalized === "edit" || normalized === "write" || normalized.includes("edit")) {
    return "file_change";
  }
  return "dynamic_tool";
}

function buildTurnMessageContent(
  text: string,
  host: ProviderHost.ProviderHost["Service"],
  attachments: ReadonlyArray<ChatAttachment>,
): string {
  const paths = attachments
    .map((attachment) => host.resolveAttachmentPath(attachment))
    .filter((path): path is string => path !== null);
  return paths.length === 0 ? text : `${text}\n\n[Attached files]\n${paths.join("\n")}`;
}

export const makeZcodeAdapterV2 = Effect.fn("makeZcodeAdapterV2")(function* (
  options: ZcodeAdapterV2Options,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* ProviderHost.ProviderHost;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const platform = yield* HostProcess.Platform;

  const protocolError = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({ driver: DRIVER_KIND, detail });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: DRIVER_KIND,
    getCapabilities: Effect.fn("ZcodeAdapterV2.getCapabilities")(function () {
      return Effect.succeed(ZcodeProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("ZcodeAdapterV2.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("ZcodeAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const providerSessionId: ProviderSessionId = input.providerSessionId;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const plan = readZcodeDesktopPlan(options.environment);
      const apiKey = options.settings.apiKey?.trim() ?? "";
      const spawnEnv: NodeJS.ProcessEnv = {
        ...options.environment,
        ...(apiKey
          ? buildZcodeProviderConfigEnv({
              cacheDir: host.paths.providerStatusCacheDir,
              apiKey,
              env: options.environment,
            })
          : {}),
      };
      // With the coding-plan API key the registry resolves the template
      // provider; otherwise only the desktop plan binding (if any) applies.
      const selectionProviderId = apiKey ? ZCODE_API_TEMPLATE_PROVIDER_ID : plan?.providerId;
      const connection: ZcodeRpcConnection = yield* makeZcodeRpcConnection({
        binaryPath: options.settings.binaryPath,
        cwd,
        env: spawnEnv,
        platform,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: DRIVER_KIND,
              providerSessionId,
              cause,
            }),
        ),
      );

      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: providerSessionId,
        driver: DRIVER_KIND,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: ZcodeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };

      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error
      >();
      let threadState: ZcodeThreadState | null = null;
      const pendingInteractions = new Map<string, PendingZcodeInteraction>();
      let closed = false;

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = sessionEntity.lastError,
      ) {
        const updatedAt = yield* DateTime.now;
        sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
        yield* emit({
          type: "provider_session.updated",
          driver: DRIVER_KIND,
          providerSession: sessionEntity,
        });
      });

      const updateThread = Effect.fnUntraced(function* (
        state: ZcodeThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        const updatedAt = yield* DateTime.now;
        state.providerThread = { ...state.providerThread, ...patch, updatedAt };
        yield* emit({
          type: "provider_thread.updated",
          driver: DRIVER_KIND,
          providerThread: state.providerThread,
        });
      });

      const baseItemFields = (
        turn: ActiveZcodeTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
        ordinal: number,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({ driver: DRIVER_KIND, nativeItemId }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({ driver: DRIVER_KIND, nativeItemId }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal,
        startedAt,
        updatedAt,
      });

      const emitItemNode = Effect.fnUntraced(function* (
        turn: ActiveZcodeTurn,
        nativeItemId: string,
        nodeKind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) {
        yield* emit({
          type: "node.updated",
          driver: DRIVER_KIND,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({ driver: DRIVER_KIND, nativeItemId }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind: nodeKind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });
      });

      const itemOrdinal = (turn: ActiveZcodeTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const emitAssistantStream = Effect.fnUntraced(function* (
        turn: ActiveZcodeTurn,
        streaming: boolean,
        status: "running" | "completed" | "failed",
      ) {
        const nativeItemId = turn.assistantItemId;
        if (nativeItemId === null) return;
        const emittedAt = yield* DateTime.now;
        const ordinal = itemOrdinal(turn, nativeItemId);
        yield* emitItemNode(
          turn,
          nativeItemId,
          "assistant_message",
          status === "running" ? "running" : "completed",
          turn.startedAt,
          streaming ? null : emittedAt,
        );
        const messageId = idAllocator.derive.messageFromProviderItem({
          driver: DRIVER_KIND,
          nativeItemId,
        });
        yield* emit({
          type: "turn_item.updated",
          driver: DRIVER_KIND,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, turn.startedAt, emittedAt, ordinal),
            status,
            title: null,
            completedAt: streaming ? null : emittedAt,
            type: "assistant_message",
            messageId,
            text: turn.assistantText,
            streaming,
          },
        });
        yield* emit({
          type: "message.updated",
          driver: DRIVER_KIND,
          message: {
            id: messageId,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: idAllocator.derive.nodeFromProviderItem({
              driver: DRIVER_KIND,
              nativeItemId,
            }),
            role: "assistant",
            text: turn.assistantText,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: turn.startedAt,
            updatedAt: emittedAt,
          },
        });
        if (!streaming) {
          turn.turnMessages.push({
            id: messageId,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: idAllocator.derive.nodeFromProviderItem({
              driver: DRIVER_KIND,
              nativeItemId,
            }),
            role: "assistant",
            text: turn.assistantText,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: turn.startedAt,
            updatedAt: emittedAt,
          });
        }
      });

      const emitReasoningStream = Effect.fnUntraced(function* (
        turn: ActiveZcodeTurn,
        streaming: boolean,
      ) {
        const nativeItemId = `reasoning:${turn.providerTurn.id}`;
        const emittedAt = yield* DateTime.now;
        const ordinal = itemOrdinal(turn, nativeItemId);
        yield* emitItemNode(
          turn,
          nativeItemId,
          "reasoning",
          streaming ? "running" : "completed",
          turn.startedAt,
          streaming ? null : emittedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: DRIVER_KIND,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, turn.startedAt, emittedAt, ordinal),
            status: streaming ? "running" : "completed",
            title: null,
            completedAt: streaming ? null : emittedAt,
            type: "reasoning",
            text: turn.reasoningText,
            streaming,
          },
        });
      });

      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActiveZcodeTurn,
        nativeItemId: string,
        toolName: string,
        shape: ZcodeToolShape,
        status: "running" | "completed" | "failed",
        payloadInput: unknown,
        outputText: string | undefined,
      ) {
        const emittedAt = yield* DateTime.now;
        const startedAt = turn.toolStartedAt.get(nativeItemId) ?? emittedAt;
        const ordinal = itemOrdinal(turn, nativeItemId);
        const completed = status !== "running";
        yield* emitItemNode(
          turn,
          nativeItemId,
          "tool_call",
          status === "running" ? "running" : status === "failed" ? "failed" : "completed",
          startedAt,
          completed ? emittedAt : null,
        );
        const shared = {
          ...baseItemFields(turn, nativeItemId, startedAt, emittedAt, ordinal),
          status,
          completedAt: completed ? emittedAt : null,
        } as const;
        const turnItem: OrchestrationV2TurnItem =
          shape === "command_execution"
            ? {
                ...shared,
                title: toolName,
                type: "command_execution",
                input: zcodeRecordString(payloadInput, "command") ?? "",
                ...(outputText === undefined ? {} : { output: outputText }),
              }
            : shape === "file_change"
              ? {
                  ...shared,
                  title: toolName,
                  type: "file_change",
                  fileName:
                    zcodeRecordString(payloadInput, "path") ??
                    zcodeRecordString(payloadInput, "file_path") ??
                    toolName,
                }
              : {
                  ...shared,
                  title: toolName,
                  type: "dynamic_tool",
                  toolName,
                  input: Predicate.isObject(payloadInput) ? payloadInput : {},
                };
        yield* emit({ type: "turn_item.updated", driver: DRIVER_KIND, turnItem });
      });

      const emitInteractionResolved = Effect.fnUntraced(function* (
        pending: PendingZcodeInteraction,
        status: "completed" | "cancelled",
      ) {
        const resolvedAt = yield* DateTime.now;
        pending.runtimeRequest = {
          ...pending.runtimeRequest,
          status: status === "completed" ? "resolved" : "cancelled",
          resolvedAt,
        };
        pending.node = { ...pending.node, status, completedAt: resolvedAt };
        pending.turnItem = {
          ...pending.turnItem,
          status,
          completedAt: resolvedAt,
          updatedAt: resolvedAt,
        };
        yield* emit({
          type: "runtime_request.updated",
          driver: DRIVER_KIND,
          threadId: pending.node.threadId,
          runtimeRequest: pending.runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: DRIVER_KIND, node: pending.node });
        yield* emit({ type: "turn_item.updated", driver: DRIVER_KIND, turnItem: pending.turnItem });
      });

      const settlePendingInteractions = Effect.fnUntraced(function* () {
        const pending = [...pendingInteractions.values()];
        pendingInteractions.clear();
        for (const interaction of pending) {
          yield* connection
            .reply(
              interaction.zcodeRequestId,
              interaction.kind === "permission"
                ? { outcome: { outcome: "cancelled" } }
                : { answers: {} },
            )
            .pipe(Effect.ignore);
          yield* emitInteractionResolved(interaction, "cancelled");
        }
      });

      const finalizeTurn = Effect.fnUntraced(function* (
        state: ZcodeThreadState,
        turn: ActiveZcodeTurn,
        outcome: "completed" | "interrupted" | "failed",
        failureMessage: string | null = null,
        threadDisposition: "reusable" | "broken" = "reusable",
      ) {
        if (state.activeTurn !== turn) return;
        state.activeTurn = null;
        const completedAt = yield* DateTime.now;
        const turnInput = turn.turnInput;

        if (turn.assistantItemId !== null) {
          yield* emitAssistantStream(turn, false, outcome === "failed" ? "failed" : "completed");
        }
        state.messages = [...state.messages, ...turn.turnMessages];

        const finalTurn: OrchestrationV2ProviderTurn = {
          ...turn.providerTurn,
          status: outcome,
          completedAt,
        };
        state.turns = [...state.turns.filter((entry) => entry.id !== finalTurn.id), finalTurn];
        yield* emit({
          type: "provider_turn.updated",
          driver: DRIVER_KIND,
          threadId: turnInput.threadId,
          providerTurn: finalTurn,
        });
        yield* updateThread(state, { status: "idle" });
        yield* updateSession(outcome === "failed" ? "error" : "ready", failureMessage);
        if (outcome === "failed") {
          const rawMessage = failureMessage ?? "ZCode turn failed.";
          const message = /select a model/i.test(rawMessage)
            ? "ZCode 3.16+ only resolves coding-plan models inside its own desktop runtime; " +
              "the spawned app-server cannot select a plan model. Update the ZCode desktop app, " +
              "or use the coding-plan API key with an Anthropic-compatible provider instead."
            : rawMessage;
          const failure: OrchestrationV2ProviderFailure = makeProviderFailure({
            message,
            class: "provider_error",
            retryable: false,
          });
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          const failureOrdinal = itemOrdinal(turn, failureItemId);
          yield* emitItemNode(turn, failureItemId, "system", "failed", completedAt, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: DRIVER_KIND,
            turnItem: {
              ...baseItemFields(turn, failureItemId, completedAt, completedAt, failureOrdinal),
              status: "failed",
              title: null,
              completedAt,
              type: "error",
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: DRIVER_KIND,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turnInput.runOrdinal,
            failureItemOrdinal: failureOrdinal,
            status: "failed",
            failure,
            threadDisposition,
          });
          return;
        }
        yield* settlePendingInteractions();
        yield* emit({
          type: "turn.terminal",
          driver: DRIVER_KIND,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turnInput.runOrdinal,
          status: outcome,
          failure: null,
          threadDisposition,
        });
      });

      const handleSessionEvent = Effect.fn("ZcodeAdapterV2.handleSessionEvent")(function* (
        state: ZcodeThreadState,
        event: ZcodeSessionEvent,
      ) {
        if (event.sessionId !== state.zcodeSessionId) return;
        if (event.type === "turn.started") {
          if (state.activeTurn !== null) state.activeTurn.nativeTurnStarted = true;
          return;
        }
        const turn = state.activeTurn;
        if (turn === null) return;
        const payload = Predicate.isObject(event.payload) ? event.payload : {};

        if (event.type === "model.streaming") {
          const kind = zcodeRecordString(payload, "kind") ?? "";
          const delta = zcodeRecordString(payload, "delta") ?? "";
          if (delta.length === 0) return;
          if (kind === "reasoning_delta") {
            turn.reasoningText += delta;
            yield* emitReasoningStream(turn, true);
            return;
          }
          if (kind === "text_delta" || kind === "") {
            if (turn.assistantItemId === null) {
              turn.assistantItemId = `assistant:${turn.providerTurn.id}`;
            }
            turn.assistantText += delta;
            yield* emitAssistantStream(turn, true, "running");
          }
          return;
        }

        if (event.type === "tool.updated") {
          const toolCallId = zcodeRecordString(payload, "toolCallId")?.trim() ?? "";
          if (toolCallId.length === 0) {
            yield* Effect.logWarning("Ignored malformed ZCode tool update without toolCallId.");
            return;
          }
          const toolName = zcodeRecordString(payload, "toolName") ?? "tool";
          const kind = zcodeRecordString(payload, "kind") ?? "started";
          const status =
            kind === "error"
              ? "failed"
              : kind === "result" || kind === "batch"
                ? "completed"
                : "running";
          if (kind === "scheduled" || kind === "started") {
            turn.toolStartedAt.set(toolCallId, yield* DateTime.now);
          }
          const outputText = zcodeRecordString(payload, "output");
          yield* emitToolItem(
            turn,
            toolCallId,
            toolName,
            zcodeToolShape(toolName),
            status,
            zcodeRecordField(payload, "input"),
            outputText,
          );
          return;
        }

        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.terminal"
        ) {
          const failed = event.type === "turn.failed";
          const failureMessage = failed
            ? Predicate.isObject(payload.error) && typeof payload.error.message === "string"
              ? payload.error.message
              : "ZCode turn failed."
            : null;
          yield* finalizeTurn(state, turn, failed ? "failed" : "completed", failureMessage);
          return;
        }
      });

      const openInteraction = Effect.fnUntraced(function* (
        state: ZcodeThreadState | null,
        request: ZcodeServerRequest,
        kind: "permission" | "user_input",
      ) {
        const turn = state?.activeTurn ?? null;
        const threadId = turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? null;
        if (threadId === null) {
          yield* rejectUnhandledZcodeServerRequest(connection, request).pipe(Effect.ignore);
          return;
        }
        const nativeRequestId = String(request.id);
        const createdAt = yield* DateTime.now;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: DRIVER_KIND,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn?.providerTurn.id ?? null,
          nativeRequestRef: providerRef(nativeRequestId),
          kind: kind === "permission" ? "command" : "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: kind === "permission" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: state?.providerThread.id ?? null,
          providerTurnId: turn?.providerTurn.id ?? null,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId: state?.providerThread.id ?? null,
          providerTurnId: turn?.providerTurn.id ?? null,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
          status: "waiting" as const,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const turnItem: OrchestrationV2TurnItem =
          kind === "permission"
            ? {
                ...itemBase,
                title: zcodeRecordString(request.params, "toolName") ?? "Permission required",
                type: "approval_request",
                requestId,
                requestKind: "command",
                prompt:
                  zcodeRecordString(request.params, "reason") ??
                  zcodeRecordString(request.params, "toolName") ??
                  "ZCode requests permission",
              }
            : {
                ...itemBase,
                title: "Question",
                type: "user_input_request",
                requestId,
                questions: userInputQuestions(request.params, nativeRequestId),
              };
        pendingInteractions.set(requestId, {
          kind,
          zcodeRequestId: request.id,
          nativeParams: request.params,
          runtimeRequest,
          node,
          turnItem,
        });
        state?.requests.push(runtimeRequest);
        yield* emit({
          type: "runtime_request.updated",
          driver: DRIVER_KIND,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: DRIVER_KIND, node });
        yield* emit({ type: "turn_item.updated", driver: DRIVER_KIND, turnItem });
      });

      const handleServerRequest = Effect.fn("ZcodeAdapterV2.handleServerRequest")(function* (
        state: ZcodeThreadState | null,
        request: ZcodeServerRequest,
      ) {
        const handled = yield* handleBuiltinZcodeServerRequest(connection, request);
        if (handled) return;
        if (request.method === "interaction/requestPermission") {
          yield* openInteraction(state, request, "permission");
          return;
        }
        if (request.method === "interaction/requestUserInput") {
          const questions = userInputQuestions(request.params, String(request.id));
          if (questions.length === 0) {
            yield* connection.reply(request.id, { answers: {} }).pipe(Effect.ignore);
            return;
          }
          yield* openInteraction(state, request, "user_input");
          return;
        }
        yield* rejectUnhandledZcodeServerRequest(connection, request).pipe(Effect.ignore);
      });

      yield* Stream.fromQueue(connection.events).pipe(
        Stream.runForEach((record) =>
          Effect.gen(function* () {
            const serverRequest = parseZcodeServerRequest(record);
            if (serverRequest !== undefined) {
              yield* handleServerRequest(threadState, serverRequest);
              return;
            }
            if (zcodeRecordString(record, "method") === "session/event") {
              const event = parseZcodeSessionEvent(zcodeRecordField(record, "params"));
              if (event !== undefined && threadState !== null) {
                yield* handleSessionEvent(threadState, event);
              }
            }
          }),
        ),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("ZCode protocol event stream ended.", { cause });
            const state = threadState;
            const turn = state?.activeTurn ?? null;
            if (state !== null && turn !== null && !closed) {
              yield* finalizeTurn(
                state,
                turn,
                "failed",
                "ZCode app-server closed during the turn.",
                "broken",
              );
            }
          }),
        ),
        Effect.forkIn(scope),
      );

      const registerThread = Effect.fn("ZcodeAdapterV2.registerThread")(function* (
        threadId: ThreadId,
        existing: OrchestrationV2ProviderThread | undefined,
        modelSelection: ModelSelection | undefined,
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined,
        fail: (cause: unknown) => ProviderAdapter.ProviderAdapterV2Error,
      ) {
        if (closed) {
          return yield* protocolError("ZCode session is closed");
        }
        if (threadState !== null) {
          if (threadState.activeTurn !== null) {
            return yield* protocolError("Cannot switch ZCode threads while a turn is active");
          }
          if (
            existing === undefined ||
            existing.nativeThreadRef?.nativeId === threadState.zcodeSessionId
          ) {
            return threadState.providerThread;
          }
        }
        const resumeId = existing?.nativeThreadRef?.nativeId ?? null;
        const sessionCwd = runtimePolicy?.cwd ?? cwd;
        const requestedModel =
          modelSelection === undefined ? undefined : resolveZcodeModelSlug(modelSelection.model);
        const mode = mapRuntimeModeToZcodeMode(
          runtimePolicy?.runtimeMode,
          runtimePolicy?.interactionMode,
        );
        const created = yield* (
          resumeId !== null
            ? zcodeResumeSession(connection, { cwd: sessionCwd, sessionId: resumeId })
            : zcodeCreateSession(connection, {
                cwd: sessionCwd,
                mode,
                ...(requestedModel ? { modelId: requestedModel } : {}),
                ...(plan?.providerId ? { providerId: plan.providerId } : {}),
              })
        ).pipe(Effect.mapError(fail));
        const createdAt = yield* DateTime.now;
        const nativeThreadId = created.sessionId;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId,
                nativeThreadRef: providerRef(nativeThreadId),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: DRIVER_KIND,
                  nativeThreadId,
                }),
                driver: DRIVER_KIND,
                providerInstanceId: options.instanceId,
                providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(nativeThreadId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              };
        threadState = {
          providerThread,
          zcodeSessionId: nativeThreadId,
          baselineModelId: created.modelId ?? null,
          appliedModelId: null,
          activeTurn: null,
          turns: [],
          messages: [],
          requests: [],
        };
        yield* emit({
          type: "provider_thread.updated",
          driver: DRIVER_KIND,
          providerThread,
        });
        return providerThread;
      });

      const applyModelSelection = Effect.fn("ZcodeAdapterV2.applyModelSelection")(function* (
        state: ZcodeThreadState,
        modelSelection: ModelSelection,
      ) {
        const requested = resolveZcodeModelSlug(modelSelection.model);
        if (requested === undefined) {
          // "default" sentinel: keep the desktop plan's own model selection.
          if (state.appliedModelId !== null && state.baselineModelId !== null) {
            yield* connection.request("session/setModel", {
              sessionId: state.zcodeSessionId,
              model: { modelId: state.baselineModelId },
            });
            state.appliedModelId = null;
          }
          return;
        }
        if (requested === state.appliedModelId) return;
        yield* connection.request("session/setModel", {
          sessionId: state.zcodeSessionId,
          model: {
            modelId: requested,
            ...(plan?.providerId ? { providerId: plan.providerId } : {}),
          },
        });
        state.appliedModelId = requested;
      });

      const connectionGone = Effect.gen(function* () {
        if (closed) return;
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (state !== null && turn !== null) {
          yield* finalizeTurn(
            state,
            turn,
            "failed",
            "ZCode app-server exited during the turn.",
            "broken",
          );
        } else if (state !== null) {
          yield* updateSession("error", "ZCode app-server exited.");
        }
      });
      yield* connection.exited.pipe(
        Effect.ignore,
        Effect.andThen(connectionGone),
        Effect.forkIn(scope),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          yield* settlePendingInteractions().pipe(Effect.ignore);
        }),
      );

      return {
        instanceId: options.instanceId,
        driver: DRIVER_KIND,
        providerSessionId,
        providerSession: sessionEntity,
        events: Stream.fromQueue(events),
        ensureThread: (ensureInput) =>
          registerThread(
            ensureInput.threadId,
            ensureInput.existingProviderThread,
            ensureInput.modelSelection,
            ensureInput.runtimePolicy,
            (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: DRIVER_KIND,
                threadId: ensureInput.threadId,
                cause,
              }),
          ),
        resumeThread: (resumeInput) =>
          registerThread(
            resumeInput.threadId ?? resumeInput.providerThread.appThreadId ?? ("" as ThreadId),
            resumeInput.providerThread,
            resumeInput.modelSelection,
            resumeInput.runtimePolicy,
            (cause) =>
              new ProviderAdapter.ProviderAdapterResumeThreadError({
                driver: DRIVER_KIND,
                providerSessionId,
                providerThreadId: resumeInput.providerThread.id,
                cause,
              }),
          ),
        startTurn: Effect.fn("ZcodeAdapterV2.startTurn")(function* (turnInput) {
          const state = threadState;
          if (state === null) {
            return yield* protocolError("ZCode session has no registered thread");
          }
          if (state.activeTurn !== null) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: DRIVER_KIND,
              detail: `ZCode provider thread ${turnInput.providerThread.id} already has an active turn`,
              reason: "previous_turn_active",
            });
          }
          const startedAt = yield* DateTime.now;
          const syntheticNativeTurnId = `${state.providerThread.id}:turn:${turnInput.providerTurnOrdinal}`;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: idAllocator.derive.providerTurn({
              driver: DRIVER_KIND,
              nativeTurnId: syntheticNativeTurnId,
            }),
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          const turn: ActiveZcodeTurn = {
            turnInput,
            providerTurn,
            startedAt,
            itemOrdinals: new Map(),
            nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
            assistantItemId: null,
            assistantText: "",
            reasoningText: "",
            turnMessages: [],
            toolStartedAt: new Map(),
            nativeTurnStarted: false,
          };
          state.providerThread = turnInput.providerThread;
          state.activeTurn = turn;
          yield* emit({
            type: "provider_turn.updated",
            driver: DRIVER_KIND,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* updateThread(state, {
            status: "active",
            firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          yield* updateSession("running", null);

          const startError = (cause: unknown) =>
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: DRIVER_KIND,
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
              runId: turnInput.runId,
              cause,
            });
          const mode = mapRuntimeModeToZcodeMode(
            turnInput.runtimePolicy.runtimeMode,
            turnInput.runtimePolicy.interactionMode,
          );
          yield* connection
            .request("session/setMode", { sessionId: state.zcodeSessionId, mode })
            .pipe(Effect.mapError(startError));
          // Model switching is best-effort: a rejected selection must not
          // fail the turn — the session keeps ZCode's own plan default.
          yield* applyModelSelection(state, turnInput.modelSelection).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("ZCode rejected the model selection; using the plan default.", {
                cause,
              }),
            ),
          );

          const content = buildTurnMessageContent(
            turnInput.message.text,
            host,
            turnInput.message.attachments,
          );
          yield* connection
            .request("session/send", { sessionId: state.zcodeSessionId, content })
            .pipe(
              Effect.mapError(startError),
              // A rejected send must not strand the thread in a running state.
              Effect.tapError(() =>
                Effect.gen(function* () {
                  state.activeTurn = null;
                  yield* updateThread(state, { status: "idle" });
                  yield* updateSession("ready", "Failed to send the turn to ZCode.");
                }),
              ),
            );
        }),
        steerTurn: Effect.fn("ZcodeAdapterV2.steerTurn")(function* (steerInput) {
          const state = threadState;
          if (state === null) {
            return yield* protocolError("ZCode session has no registered thread");
          }
          const turn = state.activeTurn;
          if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
            return yield* protocolError("No active ZCode turn to steer");
          }
          const content = buildTurnMessageContent(
            steerInput.message.text,
            host,
            steerInput.message.attachments,
          );
          yield* connection
            .request("session/send", { sessionId: state.zcodeSessionId, content })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: DRIVER_KIND,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            );
        }),
        interruptTurn: Effect.fn("ZcodeAdapterV2.interruptTurn")(function* (interruptInput) {
          const state = threadState;
          if (state === null) return;
          const turn = state.activeTurn;
          if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) return;
          yield* connection.request("session/stop", { sessionId: state.zcodeSessionId }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: DRIVER_KIND,
                  providerThreadId: state.providerThread.id,
                  providerTurnId: turn.providerTurn.id,
                  cause,
                }),
            ),
            // A failed stop request still settles the local turn so the thread cannot stick running.
            Effect.catch(() => Effect.void),
          );
          yield* finalizeTurn(state, turn, "interrupted");
        }),
        respondToRuntimeRequest: Effect.fn("ZcodeAdapterV2.respondToRuntimeRequest")(
          function* (respondInput) {
            const requestId = respondInput.requestId;
            const pending = pendingInteractions.get(requestId);
            if (pending === undefined) return;
            pendingInteractions.delete(requestId);
            const responseError = (cause: unknown) =>
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: DRIVER_KIND,
                requestId,
                cause,
              });
            if (pending.kind === "permission") {
              const decision = respondInput.decision;
              const optionId =
                decision === undefined || decision === "cancel"
                  ? undefined
                  : selectZcodePermissionOptionId(
                      permissionOptions(pending.nativeParams),
                      decision,
                    );
              yield* connection
                .reply(
                  pending.zcodeRequestId,
                  optionId === undefined
                    ? { outcome: { outcome: "cancelled" } }
                    : { outcome: { outcome: "selected", optionId } },
                )
                .pipe(Effect.mapError(responseError));
            } else {
              yield* connection
                .reply(pending.zcodeRequestId, {
                  answers: (respondInput.answers ?? {}) as Record<string, unknown>,
                })
                .pipe(Effect.mapError(responseError));
            }
            yield* emitInteractionResolved(
              pending,
              respondInput.decision === "decline" || respondInput.decision === "cancel"
                ? "cancelled"
                : "completed",
            );
          },
        ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.suspend(() => {
            const state = threadState;
            if (state === null || state.providerThread.id !== snapshotInput.providerThread.id) {
              return Effect.fail(
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver: DRIVER_KIND,
                  providerThreadId: snapshotInput.providerThread.id,
                }),
              );
            }
            return Effect.succeed({
              providerThread: state.providerThread,
              providerTurns: state.turns,
              messages: state.messages,
              runtimeRequests: state.requests,
            });
          }),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: DRIVER_KIND,
              providerThreadId: rollbackInput.providerThread.id,
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: DRIVER_KIND,
              providerThreadId: forkInput.sourceProviderThread.id,
            }),
          ),
      };
    }),
  });
});

export type ZcodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost;

export const ZcodeAdapterV2Driver: ProviderAdapterDriver<ZcodeSettings, ZcodeAdapterV2DriverEnv> = {
  driverKind: DRIVER_KIND,
  configSchema: ZcodeSettings,
  defaultConfig: (): ZcodeSettings => DEFAULT_ZCODE_SETTINGS,
  create: Effect.fn("ZcodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ZcodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      return yield* makeZcodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create ZCode adapter.",
              cause,
            }),
        ),
      ),
  ),
};
