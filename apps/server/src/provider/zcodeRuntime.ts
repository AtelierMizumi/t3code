// @effect-diagnostics globalTimers:off - request correlation owns cancellable JS timeout handles at this protocol boundary.
/**
 * ZCode Protocol client: spawn `zcode.cjs app-server --surface desktop` and
 * speak line-delimited JSON (JSON-RPC without the `jsonrpc` field).
 *
 * @module provider/zcodeRuntime
 */
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { buildZcodeAppServerArgv } from "./Drivers/ZCodeExecutable.ts";
import { buildZcodeDesktopSpawnEnv, readZcodeDesktopPlan } from "./zcodeDesktopAuth.ts";

export type ZcodeJson = Record<string, unknown>;

export interface ZcodeInboundMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

export interface ZcodeServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: unknown;
}

export interface ZcodeSessionEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

export interface ZcodeCreateSessionResult {
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

export type ZcodeServerRequestHandler = (request: ZcodeServerRequest) => Effect.Effect<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class ZcodeRuntimeError extends Schema.TaggedErrorClass<ZcodeRuntimeError>()(
  "ZcodeRuntimeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `ZCode runtime failed during ${this.operation}: ${this.detail}`;
  }
}
const isZcodeRuntimeError = Schema.is(ZcodeRuntimeError);

export function zcodeRuntimeErrorDetail(cause: unknown): string {
  if (isZcodeRuntimeError(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

function ensureZcodeRuntimeError(
  operation: string,
  detail: string,
  cause: unknown,
): ZcodeRuntimeError {
  return isZcodeRuntimeError(cause) ? cause : new ZcodeRuntimeError({ operation, detail, cause });
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

function parseAvailableModels(settings: unknown): ZcodeCreateSessionResult["availableModels"] {
  if (!Predicate.isObject(settings) || !Predicate.isObject(settings.model)) return [];
  const available = settings.model.available;
  if (!Array.isArray(available)) return [];
  const models: Array<ZcodeCreateSessionResult["availableModels"][number]> = [];
  for (const entry of available) {
    if (!Predicate.isObject(entry)) continue;
    const ref = Predicate.isObject(entry.ref) ? entry.ref : entry;
    const modelId = asString(ref.modelId) ?? asString(entry.label);
    if (!modelId) continue;
    models.push({
      modelId,
      providerId: asString(ref.providerId),
      label: asString(entry.label) ?? modelId,
    });
  }
  return models;
}

export function parseZcodeCreateResult(raw: unknown): ZcodeCreateSessionResult {
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
  const sessionId = asString(session.sessionId) ?? asString(record.sessionId) ?? "";
  return {
    sessionId,
    modelId: current ? asString(current.modelId) : undefined,
    providerId: current ? asString(current.providerId) : undefined,
    availableModels: parseAvailableModels(settings),
    raw,
  };
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

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ZcodeRuntimeError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ZcodeProtocolClient {
  private readonly proc: ChildProcessSpawner.ChildProcessHandle;
  private readonly writeSemaphore: Semaphore.Semaphore;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private eventHandler: ((event: ZcodeSessionEvent) => void) | undefined;
  private serverRequestHandler: ((request: ZcodeServerRequest) => void) | undefined;

  constructor(proc: ChildProcessSpawner.ChildProcessHandle, writeSemaphore: Semaphore.Semaphore) {
    this.proc = proc;
    this.writeSemaphore = writeSemaphore;
  }

  start(): Effect.Effect<void, never, Scope.Scope> {
    const stdout = this.proc.stdout;
    const stderr = this.proc.stderr;
    const exitCode = this.proc.exitCode;
    const close = (error: ZcodeRuntimeError) => this.close(error);
    const onLine = (line: string) => this.onLine(line);
    return Effect.gen(function* () {
      yield* stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Effect.sync(() => onLine(line))),
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            close(
              new ZcodeRuntimeError({
                operation: "readStdout",
                detail: "ZCode app-server stdout failed.",
                cause,
              }),
            ),
          onSuccess: () =>
            close(
              new ZcodeRuntimeError({
                operation: "readStdout",
                detail: "ZCode app-server stdout closed.",
              }),
            ),
        }),
        Effect.forkScoped,
      );
      yield* stderr.pipe(
        Stream.runDrain,
        Effect.catchCause((cause) =>
          close(
            new ZcodeRuntimeError({
              operation: "readStderr",
              detail: "ZCode app-server stderr failed.",
              cause,
            }),
          ),
        ),
        Effect.forkScoped,
      );
      yield* exitCode.pipe(
        Effect.flatMap((code) =>
          close(
            new ZcodeRuntimeError({
              operation: "processExit",
              detail: `ZCode app-server exited with code ${Number(code)}.`,
            }),
          ),
        ),
        Effect.catch((cause) =>
          close(
            new ZcodeRuntimeError({
              operation: "processExit",
              detail: "ZCode app-server exit status failed.",
              cause,
            }),
          ),
        ),
        Effect.forkScoped,
      );
    });
  }

  setEventHandler(handler: (event: ZcodeSessionEvent) => void): void {
    this.eventHandler = handler;
  }

  setServerRequestHandler(handler: (request: ZcodeServerRequest) => void): void {
    this.serverRequestHandler = handler;
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new ZcodeRuntimeError({
          operation: method,
          detail: "ZCode app-server is closed.",
        }),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(
          new ZcodeRuntimeError({
            operation: method,
            detail: "ZCode request timed out.",
          }),
        );
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve, reject, timer });
      void this.write({ id, method, params: params ?? {} }).catch((cause) => {
        const pending = this.pending.get(String(id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(String(id));
        const error = ensureZcodeRuntimeError(method, "Failed to write ZCode request.", cause);
        pending.reject(error);
        void Effect.runPromise(this.close(error));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params: params ?? {} });
  }

  reply(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  replyError(id: number | string, message: string, code = -32000): void {
    this.send({ id, error: { code, message } });
  }

  close(
    error = new ZcodeRuntimeError({
      operation: "close",
      detail: "ZCode app-server closed.",
    }),
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      this.closed = true;
      this.failAll(error);
      return this.proc.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
    });
  }

  private send(payload: unknown): void {
    void this.write(payload).catch((cause) => {
      const error = ensureZcodeRuntimeError("write", "Failed to write ZCode message.", cause);
      void Effect.runPromise(this.close(error));
    });
  }

  private write(payload: unknown): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        new ZcodeRuntimeError({ operation: "write", detail: "ZCode app-server is closed." }),
      );
    }
    const encoded = `${JSON.stringify(payload)}\n`;
    return Effect.runPromise(
      this.writeSemaphore.withPermit(
        Stream.run(Stream.encodeText(Stream.make(encoded)), this.proc.stdin).pipe(
          Effect.mapError(
            (cause) =>
              new ZcodeRuntimeError({
                operation: "write",
                detail: "Failed to write to ZCode app-server stdin.",
                cause,
              }),
          ),
        ),
      ),
    );
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!Predicate.isObject(parsed)) return;
    const message = parsed as ZcodeInboundMessage;
    const id =
      typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (id !== undefined && method !== undefined) {
      this.serverRequestHandler?.({ id, method, params: message.params });
      return;
    }
    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(id));
      if (Predicate.isObject(message.error)) {
        pending.reject(
          new ZcodeRuntimeError({
            operation: pending.method,
            detail:
              typeof message.error.message === "string"
                ? message.error.message
                : `ZCode request failed (${String(message.error.code ?? "?")}).`,
          }),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (method === "session/event") {
      const event = parseZcodeSessionEvent(message.params);
      if (event) this.eventHandler?.(event);
    }
  }

  private failAll(error: ZcodeRuntimeError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const startZcodeProtocolClient = (input: {
  readonly binaryPath: string | null | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.Effect<
  ZcodeProtocolClient,
  ZcodeRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcessPlatform;
    const environment = input.environment ?? process.env;
    const argv = buildZcodeAppServerArgv({
      binaryPath: input.binaryPath,
      env: environment,
      platform,
    });
    const plan = readZcodeDesktopPlan(input.environment);
    const env = buildZcodeDesktopSpawnEnv(environment, plan);
    const proc = yield* spawner
      .spawn(
        ChildProcess.make(argv.command, argv.args, {
          cwd: input.cwd,
          env,
          stdin: { stream: "pipe", endOnDone: false },
          detached: platform !== "win32",
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ZcodeRuntimeError({
              operation: "spawn",
              detail: "Failed to start ZCode app-server.",
              cause,
            }),
        ),
      );
    const writeSemaphore = yield* Semaphore.make(1);
    const client = new ZcodeProtocolClient(proc, writeSemaphore);
    yield* client.start();
    yield* Effect.addFinalizer(() => client.close());
    return client;
  });

export const handleBuiltinZcodeServerRequest = (
  client: ZcodeProtocolClient,
  request: ZcodeServerRequest,
): boolean => {
  if (request.method === "session/requestRuntimePreferences") {
    client.reply(request.id, {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false,
    });
    return true;
  }
  if (request.method === "interaction/requestProviderRuntimeHeaders") {
    client.reply(request.id, {});
    return true;
  }
  return false;
};

export const rejectUnhandledZcodeServerRequest = (
  client: ZcodeProtocolClient,
  request: ZcodeServerRequest,
): void => {
  if (request.method === "interaction/requestPermission") {
    client.reply(request.id, { outcome: { outcome: "cancelled" } });
    return;
  }
  if (request.method === "interaction/requestUserInput") {
    client.reply(request.id, { answers: {} });
    return;
  }
  client.replyError(request.id, `Unsupported ZCode server request: ${request.method}`);
};

const runZcodeRequest = (
  client: ZcodeProtocolClient,
  method: string,
  params: unknown,
): Effect.Effect<unknown, ZcodeRuntimeError> =>
  Effect.tryPromise({
    try: () => client.request(method, params),
    catch: (cause) =>
      ensureZcodeRuntimeError(
        method,
        `ZCode request failed: ${zcodeRuntimeErrorDetail(cause)}`,
        cause,
      ),
  });

export const zcodeCreateSession = (
  client: ZcodeProtocolClient,
  input: {
    readonly cwd: string;
    readonly mode: "yolo" | "build" | "edit" | "plan";
    readonly modelId?: string;
    readonly providerId?: string;
  },
): Effect.Effect<ZcodeCreateSessionResult, ZcodeRuntimeError> =>
  Effect.gen(function* () {
    const params: ZcodeJson = {
      workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
      mode: input.mode,
    };
    if (input.modelId) {
      params.model = {
        modelId: input.modelId,
        ...(input.providerId ? { providerId: input.providerId } : {}),
      };
    }
    const raw = yield* runZcodeRequest(client, "session/create", params);
    const created = parseZcodeCreateResult(raw);
    if (!created.sessionId) {
      return yield* new ZcodeRuntimeError({
        operation: "session/create",
        detail: "ZCode session/create did not return a sessionId.",
      });
    }
    yield* runZcodeRequest(client, "session/subscribe", {
      sessionId: created.sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: true,
      afterSeq: 0,
    });
    return created;
  });

export const zcodeResumeSession = (
  client: ZcodeProtocolClient,
  input: { readonly cwd: string; readonly sessionId: string },
): Effect.Effect<ZcodeCreateSessionResult, ZcodeRuntimeError> =>
  Effect.gen(function* () {
    const raw = yield* runZcodeRequest(client, "session/resume", {
      sessionId: input.sessionId,
      workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
    });
    const resumed = parseZcodeCreateResult(raw);
    const sessionId = resumed.sessionId || input.sessionId;
    yield* runZcodeRequest(client, "session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: true,
      afterSeq: 0,
    });
    return { ...resumed, sessionId };
  });
