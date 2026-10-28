/**
 * ZCode Protocol client: spawn `zcode.cjs app-server --surface desktop` and
 * speak line-delimited JSON (JSON-RPC without the `jsonrpc` field).
 *
 * @module provider/zcodeRuntime
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!isRecord(settings) || !isRecord(settings.model)) return [];
  const available = settings.model.available;
  if (!Array.isArray(available)) return [];
  const models: Array<ZcodeCreateSessionResult["availableModels"][number]> = [];
  for (const entry of available) {
    if (!isRecord(entry)) continue;
    const ref = isRecord(entry.ref) ? entry.ref : entry;
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
  const record = isRecord(raw) ? raw : {};
  const session = isRecord(record.session) ? record.session : record;
  const settings = record.settings;
  const model = isRecord(session.model) ? session.model : undefined;
  const current =
    isRecord(settings) && isRecord(settings.model) && isRecord(settings.model.current)
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
  if (!isRecord(params)) return undefined;
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
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ZcodeProtocolClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly reader: ReadlineInterface;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private eventHandler: ((event: ZcodeSessionEvent) => void) | undefined;
  private serverRequestHandler: ((request: ZcodeServerRequest) => void) | undefined;

  constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
    this.reader = createInterface({ input: proc.stdout });
    this.reader.on("line", (line) => this.onLine(line));
    this.reader.on("close", () => this.failAll(new Error("ZCode app-server stdout closed.")));
    proc.on("exit", (code, signal) => {
      this.failAll(
        new Error(
          `ZCode app-server exited${code !== null ? ` with code ${code}` : ""}${
            signal ? ` (${signal})` : ""
          }.`,
        ),
      );
    });
    proc.stdin.on("error", () => {
      this.closed = true;
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
      return Promise.reject(new Error("ZCode app-server is closed."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`ZCode request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.write({ id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params: params ?? {} });
  }

  reply(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  replyError(id: number | string, message: string, code = -32000): void {
    this.write({ id, error: { code, message } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("ZCode app-server closed."));
    this.reader.close();
    const pid = this.proc.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        this.proc.kill("SIGTERM");
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (pid) process.kill(-pid, "SIGKILL");
        } catch {
          this.proc.kill("SIGKILL");
        }
        resolve();
      }, 2_000);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private write(payload: unknown): void {
    if (this.closed || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: ZcodeInboundMessage;
    try {
      message = JSON.parse(trimmed) as ZcodeInboundMessage;
    } catch {
      return;
    }
    const id = message.id;
    const method = message.method;
    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(id));
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ?? `ZCode request failed (${message.error.code ?? "?"}).`,
          ),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (id !== undefined && method !== undefined) {
      if (this.pending.has(String(id))) {
        const pending = this.pending.get(String(id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(String(id));
          pending.resolve(message.result);
        }
        return;
      }
      this.serverRequestHandler?.({ id, method, params: message.params });
      return;
    }
    if (method === "session/event") {
      const event = parseZcodeSessionEvent(message.params);
      if (event) this.eventHandler?.(event);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
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
}): Effect.Effect<ZcodeProtocolClient, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const argv = buildZcodeAppServerArgv({
          binaryPath: input.binaryPath,
          env: input.environment,
        });
        const plan = readZcodeDesktopPlan(input.environment);
        const env = buildZcodeDesktopSpawnEnv(input.environment ?? process.env, plan);
        const proc = spawn(argv.command, [...argv.args], {
          cwd: input.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        }) as ChildProcessWithoutNullStreams;
        return new ZcodeProtocolClient(proc);
      },
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error(`Failed to start ZCode app-server: ${String(cause)}`),
    }),
    (client) => Effect.promise(() => client.close()),
  );

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

export const zcodeCreateSession = (
  client: ZcodeProtocolClient,
  input: {
    readonly cwd: string;
    readonly mode: "yolo" | "build" | "edit" | "plan";
    readonly modelId?: string;
    readonly providerId?: string;
  },
): Effect.Effect<ZcodeCreateSessionResult, Error> =>
  Effect.tryPromise({
    try: async () => {
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
      const raw = await client.request("session/create", params);
      const created = parseZcodeCreateResult(raw);
      if (!created.sessionId) {
        throw new Error("ZCode session/create did not return a sessionId.");
      }
      await client.request("session/subscribe", {
        sessionId: created.sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: true,
        afterSeq: 0,
      });
      return created;
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`ZCode session/create failed: ${String(cause)}`),
  });

export const zcodeResumeSession = (
  client: ZcodeProtocolClient,
  input: { readonly cwd: string; readonly sessionId: string },
): Effect.Effect<ZcodeCreateSessionResult, Error> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await client.request("session/resume", {
        sessionId: input.sessionId,
        workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
      });
      const resumed = parseZcodeCreateResult(raw);
      const sessionId = resumed.sessionId || input.sessionId;
      await client.request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: true,
        afterSeq: 0,
      });
      return { ...resumed, sessionId };
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`ZCode session/resume failed: ${String(cause)}`),
  });
