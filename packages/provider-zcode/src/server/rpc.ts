// ZCode Protocol: LF-delimited JSON lines, JSON-RPC without the `jsonrpc`
// field. Responses match pending requests by id; every other stdout record
// (server→client requests, `session/event` notifications) goes to the queue.
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

import { buildZcodeAppServerArgv } from "./executable.ts";
import { buildZcodeDesktopSpawnEnv, readZcodeDesktopPlan } from "./desktopAuth.ts";

export class ZcodeRpcError extends Schema.TaggedError<ZcodeRpcError>()("ZcodeRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `ZCode RPC ${this.operation} failed${
      this.detail === undefined ? "" : `: ${this.detail}`
    }.`;
  }
}

export class ZcodeRpcTimeoutError extends Schema.TaggedError<ZcodeRpcTimeoutError>()(
  "ZcodeRpcTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
) {
  override get message(): string {
    return `ZCode RPC ${this.operation} failed: timed out after ${this.timeoutMs}ms.`;
  }
}

export type ZcodeRpcRecord = Record<string, unknown>;

export function zcodeRecordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

export function zcodeRecordString(input: unknown, key: string): string | undefined {
  const value = zcodeRecordField(input, key);
  return Predicate.isString(value) ? value : undefined;
}

export function zcodeRecordNumber(input: unknown, key: string): number | undefined {
  const value = zcodeRecordField(input, key);
  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function mapRuntimeModeToZcodeMode(
  runtimeMode: string | undefined,
  interactionMode: string | undefined,
): "yolo" | "build" | "edit" | "plan" {
  if (interactionMode === "plan") return "plan";
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "edit";
    default:
      return "build";
  }
}

/**
 * Model slugs are plain ZCode model ids ("GLM-5.3"); the "default" sentinel
 * defers to the desktop app's configured plan model and is never sent.
 */
export function resolveZcodeModelSlug(slug: string): string | undefined {
  const trimmed = slug.trim();
  if (trimmed.length === 0 || trimmed === "default") return undefined;
  const prefixed = /^zcode\//i.exec(trimmed);
  return prefixed !== null ? trimmed.slice(prefixed[0].length) : trimmed;
}

function parseAvailableModels(settings: unknown): ReadonlyArray<{
  readonly modelId: string;
  readonly providerId: string | undefined;
  readonly label: string | undefined;
}> {
  if (!Predicate.isObject(settings) || !Predicate.isObject(settings.model)) return [];
  const available = settings.model.available;
  if (!Array.isArray(available)) return [];
  const models: Array<{
    readonly modelId: string;
    readonly providerId: string | undefined;
    readonly label: string | undefined;
  }> = [];
  for (const entry of available) {
    if (!Predicate.isObject(entry)) continue;
    const ref = Predicate.isObject(entry.ref) ? entry.ref : entry;
    const modelId = asString(zcodeRecordField(ref, "modelId")) ?? asString(entry.label);
    if (!modelId) continue;
    models.push({
      modelId,
      providerId: asString(zcodeRecordField(ref, "providerId")),
      label: asString(entry.label) ?? modelId,
    });
  }
  return models;
}

export interface ZcodeSessionCreateResult {
  readonly sessionId: string;
  readonly modelId: string | undefined;
  readonly providerId: string | undefined;
  readonly availableModels: ReadonlyArray<{
    readonly modelId: string;
    readonly providerId: string | undefined;
    readonly label: string | undefined;
  }>;
  readonly raw: unknown;
}

export function parseZcodeCreateResult(raw: unknown): ZcodeSessionCreateResult {
  const record = Predicate.isObject(raw) ? raw : {};
  const session = Predicate.isObject(record.session) ? record.session : record;
  const settings = record.settings;
  const model = Predicate.isObject(session.model) ? session.model : undefined;
  const current =
    Predicate.isObject(settings) &&
    Predicate.isObject(settings.model) &&
    Predicate.isObject(settings.model.current)
      ? settings.model.current
      : model;
  const sessionId =
    asString(zcodeRecordField(session, "sessionId")) ??
    asString(zcodeRecordField(record, "sessionId")) ??
    "";
  return {
    sessionId,
    modelId: current ? asString(zcodeRecordField(current, "modelId")) : undefined,
    providerId: current ? asString(zcodeRecordField(current, "providerId")) : undefined,
    availableModels: parseAvailableModels(settings),
    raw,
  };
}

export interface ZcodeSessionEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

export function parseZcodeSessionEvent(params: unknown): ZcodeSessionEvent | undefined {
  if (!Predicate.isObject(params)) return undefined;
  const sessionId = asString(params.sessionId);
  const type = asString(params.type);
  if (!sessionId || !type) return undefined;
  return {
    sessionId,
    seq: typeof params.seq === "number" ? params.seq : 0,
    type,
    payload: params.payload,
  };
}

export interface ZcodeServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: unknown;
}

export function parseZcodeServerRequest(record: ZcodeRpcRecord): ZcodeServerRequest | undefined {
  const id = zcodeRecordField(record, "id");
  const method = zcodeRecordString(record, "method");
  if ((typeof id !== "number" && typeof id !== "string") || method === undefined) return undefined;
  return { id, method, params: zcodeRecordField(record, "params") };
}

export interface ZcodeRpcSpawnInput {
  readonly binaryPath: string | null | undefined;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

export interface ZcodeRpcConnection {
  readonly request: (
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, ZcodeRpcError | ZcodeRpcTimeoutError>;
  readonly send: (record: ZcodeRpcRecord) => Effect.Effect<void, ZcodeRpcError>;
  readonly reply: (id: number | string, result: unknown) => Effect.Effect<void, ZcodeRpcError>;
  readonly replyError: (
    id: number | string,
    message: string,
    code?: number,
  ) => Effect.Effect<void, ZcodeRpcError>;
  readonly events: Queue.Queue<ZcodeRpcRecord, ZcodeRpcError>;
  readonly exited: Effect.Effect<number, ZcodeRpcError>;
  readonly terminate: Effect.Effect<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE = Duration.seconds(2);

interface PendingZcodeRequest {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, ZcodeRpcError>;
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);

function parseZcodeLine(line: string): ZcodeRpcRecord | undefined {
  try {
    const parsed: unknown = decodeJsonLine(line);
    return Predicate.isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `hasExited` is consulted before each signal. Once the original child is
 * gone its pid/pgid can be recycled by the OS, so escalating blindly could
 * deliver SIGKILL to an unrelated process.
 */
const terminateZcodeProcess = Effect.fn("ZcodeRpc.terminateZcodeProcess")(function* (
  kill: (signal: NodeJS.Signals) => boolean,
  hasExited: () => boolean,
) {
  if (hasExited()) return;
  if (!kill("SIGTERM")) return;
  yield* Effect.sleep(TERMINATION_GRACE);
  if (hasExited()) return;
  kill("SIGKILL");
});

export const makeZcodeRpcConnection = Effect.fnUntraced(function* (input: ZcodeRpcSpawnInput) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;

  const argv = buildZcodeAppServerArgv({
    binaryPath: input.binaryPath,
    env: input.env,
    platform: input.platform,
  });
  const plan = readZcodeDesktopPlan(input.env);
  const env = {
    ...buildZcodeDesktopSpawnEnv(input.env, plan),
    ...(argv.envExtras ?? {}),
  };

  const child = yield* spawner
    .spawn(
      ChildProcess.make(argv.command, [...argv.args], {
        cwd: input.cwd,
        env,
        extendEnv: false,
        stdin: { stream: "pipe", endOnDone: false },
        detached: input.platform !== "win32",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ZcodeRpcError({
            operation: "spawn",
            detail: "Failed to start ZCode app-server.",
            cause,
          }),
      ),
    );

  let childExited = false;
  let transportFailed = false;

  const killProcessGroup = (signal: NodeJS.Signals): boolean => {
    try {
      if (input.platform === "win32") {
        process.kill(Number(child.pid), signal);
      } else {
        signalProcessGroup(Number(child.pid), signal);
      }
      return true;
    } catch {
      return false;
    }
  };

  const hasExited = (): boolean => {
    if (childExited) return true;
    try {
      if (input.platform === "win32") process.kill(Number(child.pid), 0);
      else signalProcessGroup(Number(child.pid), 0);
      return false;
    } catch {
      return true;
    }
  };

  const terminateProcess =
    input.platform === "win32"
      ? Effect.sync(() => {
          if (hasExited()) return;
          killProcessGroup("SIGTERM");
        })
      : terminateZcodeProcess(killProcessGroup, hasExited);

  // Register teardown immediately after spawn so interrupted setup cannot leak a detached process.
  yield* Scope.addFinalizer(scope, terminateProcess.pipe(Effect.ignore, Effect.uninterruptible));

  const pendingRequests = new Map<string, PendingZcodeRequest>();
  const events = yield* Queue.unbounded<ZcodeRpcRecord, ZcodeRpcError>();
  const exitDeferred = yield* Deferred.make<number, ZcodeRpcError>();
  const writeSemaphore = yield* Semaphore.make(1);
  let nextRequestId = 1;

  const failTransport = Effect.fn("ZcodeRpc.failTransport")(function* (error: ZcodeRpcError) {
    if (transportFailed) return;
    transportFailed = true;
    for (const [key, pending] of pendingRequests) {
      pendingRequests.delete(key);
      yield* Deferred.fail(pending.deferred, error);
    }
    yield* Queue.fail(events, error);
  });

  const encodeLine = (payload: unknown): Uint8Array =>
    new TextEncoder().encode(`${JSON.stringify(payload)}\n`);

  const writeRecord = (payload: unknown) =>
    writeSemaphore.withPermit(
      Stream.run(Stream.make(encodeLine(payload)), child.stdin).pipe(
        Effect.mapError(
          (cause) =>
            new ZcodeRpcError({
              operation: "write",
              detail: "Failed to write to ZCode app-server stdin.",
              cause,
            }),
        ),
      ),
    );

  const send = (record: ZcodeRpcRecord): Effect.Effect<void, ZcodeRpcError> =>
    Effect.suspend(() => {
      if (childExited || transportFailed) {
        return Effect.fail(
          new ZcodeRpcError({ operation: "write", detail: "ZCode app-server is closed" }),
        );
      }
      return writeRecord(record);
    });

  const routeRecord = Effect.fnUntraced(function* (record: ZcodeRpcRecord) {
    // Responses carry an id plus result/error and no method; server requests
    // and notifications carry a method and go to the events queue.
    const id = zcodeRecordField(record, "id");
    const isMethodCall = zcodeRecordString(record, "method") !== undefined;
    if (
      !isMethodCall &&
      (typeof id === "number" || typeof id === "string") &&
      ("result" in record || "error" in record)
    ) {
      const pending = pendingRequests.get(String(id));
      if (pending === undefined) return;
      pendingRequests.delete(String(id));
      if ("error" in record) {
        const error = zcodeRecordField(record, "error");
        yield* Deferred.fail(
          pending.deferred,
          new ZcodeRpcError({
            operation: pending.operation,
            detail: zcodeRecordString(error, "message") ?? "ZCode request failed.",
          }),
        );
        return;
      }
      yield* Deferred.succeed(pending.deferred, zcodeRecordField(record, "result"));
      return;
    }
    yield* Queue.offer(events, record);
  });

  const watchExit = Effect.fn("ZcodeRpc.watchExit")(function* () {
    yield* child.exitCode.pipe(
      Effect.matchEffect({
        onFailure: Effect.fn("ZcodeRpc.exitFailure")(function* (cause) {
          childExited = true;
          yield* Deferred.fail(exitDeferred, new ZcodeRpcError({ operation: "exit", cause }));
          yield* failTransport(new ZcodeRpcError({ operation: "exit", cause }));
        }),
        onSuccess: Effect.fn("ZcodeRpc.exitSuccess")(function* (code) {
          childExited = true;
          yield* Deferred.succeed(exitDeferred, Number(code));
        }),
      }),
    );
  });

  yield* watchExit().pipe(Effect.forkIn(scope));

  const readStdout = Effect.fn("ZcodeRpc.readStdout")(function* () {
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const record = parseZcodeLine(line.trim());
          if (record !== undefined) {
            yield* routeRecord(record);
          }
        }),
      ),
    );
  });

  yield* readStdout().pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        failTransport(
          new ZcodeRpcError({
            operation: "read",
            detail: "ZCode app-server stdout failed",
            cause,
          }),
        ),
      onSuccess: () =>
        failTransport(
          new ZcodeRpcError({
            operation: "read",
            detail: "ZCode app-server stdout closed",
          }),
        ),
    }),
    Effect.forkIn(scope),
  );

  // Drain stderr: a full pipe buffer would block the app-server with no protocol progress.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      chunk.trim().length === 0
        ? Effect.void
        : Effect.logDebug("zcode stderr", { stderrLength: chunk.length }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  const request = Effect.fn("ZcodeRpc.request")(function* (
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    const id = nextRequestId++;
    const deferred = yield* Deferred.make<unknown, ZcodeRpcError>();
    pendingRequests.set(String(id), { operation: method, deferred });
    yield* send({ id, method, params: params ?? {} }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          pendingRequests.delete(String(id));
          return yield* cause;
        }),
      ),
    );
    const result = yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
    );
    if (Option.isNone(result)) {
      pendingRequests.delete(String(id));
      return yield* new ZcodeRpcTimeoutError({ operation: method, timeoutMs });
    }
    return result.value;
  });

  return {
    request,
    send,
    reply: (id: number | string, result: unknown) => send({ id, result }),
    replyError: (id: number | string, message: string, code = -32000) =>
      send({ id, error: { code, message } }),
    events,
    exited: Deferred.await(exitDeferred),
    terminate: terminateProcess,
  };
});

export const zcodeCreateSession = Effect.fn("ZcodeRpc.zcodeCreateSession")(function* (
  connection: ZcodeRpcConnection,
  input: {
    readonly cwd: string;
    readonly mode: "yolo" | "build" | "edit" | "plan";
    readonly modelId?: string;
    readonly providerId?: string;
  },
) {
  const params: ZcodeRpcRecord = {
    workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
    mode: input.mode,
  };
  if (input.modelId) {
    params.model = {
      modelId: input.modelId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
    };
  }
  const raw = yield* connection.request("session/create", params);
  const created = parseZcodeCreateResult(raw);
  if (!created.sessionId) {
    return yield* new ZcodeRpcError({
      operation: "session/create",
      detail: "ZCode session/create did not return a sessionId",
    });
  }
  yield* connection.request("session/subscribe", {
    sessionId: created.sessionId,
    deliveryKind: "desktop-continuous",
    includeSnapshot: true,
    afterSeq: 0,
  });
  return created;
});

export const zcodeResumeSession = Effect.fn("ZcodeRpc.zcodeResumeSession")(function* (
  connection: ZcodeRpcConnection,
  input: { readonly cwd: string; readonly sessionId: string },
) {
  const raw = yield* connection.request("session/resume", {
    sessionId: input.sessionId,
    workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
  });
  const resumed = parseZcodeCreateResult(raw);
  const sessionId = resumed.sessionId || input.sessionId;
  yield* connection.request("session/subscribe", {
    sessionId,
    deliveryKind: "desktop-continuous",
    includeSnapshot: true,
    afterSeq: 0,
  });
  return { ...resumed, sessionId };
});

export const handleBuiltinZcodeServerRequest = (
  connection: ZcodeRpcConnection,
  request: ZcodeServerRequest,
): Effect.Effect<boolean> => {
  // A failed built-in reply means the transport is going down; report handled
  // either way so callers do not treat it as an unknown request.
  const reply = (result: unknown) =>
    connection.reply(request.id, result).pipe(Effect.ignore, Effect.as(true));
  if (request.method === "session/requestRuntimePreferences") {
    return reply({
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false,
    });
  }
  if (request.method === "interaction/requestProviderRuntimeHeaders") {
    return reply({});
  }
  return Effect.succeed(false);
};

export const rejectUnhandledZcodeServerRequest = (
  connection: ZcodeRpcConnection,
  request: ZcodeServerRequest,
): Effect.Effect<void, ZcodeRpcError> => {
  if (request.method === "interaction/requestPermission") {
    return connection.reply(request.id, { outcome: { outcome: "cancelled" } });
  }
  if (request.method === "interaction/requestUserInput") {
    return connection.reply(request.id, { answers: {} });
  }
  return connection.replyError(request.id, `Unsupported ZCode server request: ${request.method}`);
};
