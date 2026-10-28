// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  ZCodeSettings,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeZcodeAdapter, selectZcodePermissionOptionId } from "./ZCodeAdapter.ts";

const decodeZcodeSettings = Schema.decodeSync(ZCodeSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/zcode-mock-app-server.mjs");

const zcodeAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-zcode-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it("selects only a permission option that matches the requested decision", () => {
  const options = [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ];

  assert.equal(selectZcodePermissionOptionId(options, "decline"), "reject");
  assert.equal(
    selectZcodePermissionOptionId([{ optionId: "allow", kind: "allow_once" }], "decline"),
    undefined,
  );
});

it.layer(zcodeAdapterTestLayer)("ZCodeAdapterLive", (it) => {
  it.effect("starts a session and maps mock ZCode events to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("zcode-mock-thread");
      const adapter = yield* makeZcodeAdapter(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
      );

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("zcode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("zcode"), model: "GLM-5.3" },
      });

      assert.equal(session.provider, "zcode");
      assert.equal(session.model, "GLM-5.3");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "sess_mock_zcode",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello zcode",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((event) => event.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);
      const itemStarted = runtimeEvents.find((event) => event.type === "item.started");
      const contentDelta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(itemStarted);
      assert.isDefined(contentDelta);
      assert.notEqual(itemStarted.eventId, contentDelta.eventId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores ready state and aborts the turn when session/send fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("zcode-send-failure");
      const adapter = yield* makeZcodeAdapter(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
      );
      const aborted = yield* Deferred.make<void>();
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.aborted" ? Deferred.succeed(aborted, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("zcode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("zcode"), model: "GLM-5.3" },
      });
      const error = yield* adapter
        .sendTurn({ threadId, input: "__fail_send__", attachments: [] })
        .pipe(Effect.flip);
      yield* Deferred.await(aborted);

      const [session] = yield* adapter.listSessions();
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(session?.status, "ready");
      assert.equal(session?.activeTurnId, undefined);
      assert.equal(session?.lastError, "mock send failed");
      assert.isTrue(events.some((event) => event.type === "turn.aborted"));

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores the runtime mode after a plan turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("zcode-mode-reset");
      const adapter = yield* makeZcodeAdapter(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
      );
      const firstCompleted = yield* Deferred.make<void>();
      const secondCompleted = yield* Deferred.make<void>();
      const deltas: string[] = [];
      let completionCount = 0;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
            deltas.push(event.payload.delta);
          }
          if (event.type === "turn.completed") {
            completionCount += 1;
            yield* Deferred.succeed(
              completionCount === 1 ? firstCompleted : secondCompleted,
              undefined,
            ).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("zcode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("zcode"), model: "GLM-5.3" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "__echo_mode__",
        attachments: [],
        interactionMode: "plan",
      });
      yield* Deferred.await(firstCompleted);
      yield* adapter.sendTurn({ threadId, input: "__echo_mode__", attachments: [] });
      yield* Deferred.await(secondCompleted);

      assert.deepStrictEqual(deltas, ["mode:plan", "mode:yolo"]);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps the previous model when an in-session model switch fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("zcode-model-failure");
      const adapter = yield* makeZcodeAdapter(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("zcode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("zcode"), model: "GLM-5.3" },
      });
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "switch model",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("zcode"),
            model: "GLM-BROKEN",
          },
        })
        .pipe(Effect.flip);

      const [session] = yield* adapter.listSessions();
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(session?.status, "ready");
      assert.equal(session?.model, "GLM-5.3");
      assert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels open permission requests when a turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("zcode-interrupt-permission");
      const adapter = yield* makeZcodeAdapter(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
      );
      const opened = yield* Deferred.make<ApprovalRequestId>();
      const resolved = yield* Deferred.make<ProviderRuntimeEvent>();
      const aborted = yield* Deferred.make<void>();
      const terminalEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          terminalEvents.push(event);
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(opened, ApprovalRequestId.make(event.requestId)).pipe(
              Effect.ignore,
            );
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(resolved, event).pipe(Effect.ignore);
          }
          if (event.type === "turn.aborted") {
            yield* Deferred.succeed(aborted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("zcode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("zcode"), model: "GLM-5.3" },
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "__permission__",
        attachments: [],
      });
      const requestId = yield* Deferred.await(opened);
      yield* adapter.interruptTurn(threadId, turn.turnId);
      const resolvedEvent = yield* Deferred.await(resolved);
      yield* Deferred.await(aborted);

      assert.equal(resolvedEvent.type, "request.resolved");
      if (resolvedEvent.type === "request.resolved") {
        assert.equal(resolvedEvent.payload.decision, "cancel");
      }
      yield* adapter.respondToRequest(threadId, requestId, "accept");
      const [session] = yield* adapter.listSessions();
      assert.equal(session?.status, "ready");
      assert.equal(session?.activeTurnId, undefined);
      assert.isFalse(terminalEvents.some((event) => event.type === "turn.completed"));

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps client and server request id namespaces independent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("zcode-request-id-collision");
      const adapter = yield* makeZcodeAdapter(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
      );
      const opened = yield* Deferred.make<ApprovalRequestId>();
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(opened, ApprovalRequestId.make(event.requestId)).pipe(
              Effect.ignore,
            );
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(completed, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("zcode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("zcode"), model: "GLM-5.3" },
      });
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "__permission_collision__", attachments: [] })
        .pipe(Effect.forkChild);
      const requestId = yield* Deferred.await(opened);
      yield* adapter.respondToRequest(threadId, requestId, "decline");
      yield* Fiber.join(sendFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores valid JSON protocol values that are not message objects", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("zcode-malformed-json-value");
      const adapter = yield* makeZcodeAdapter(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
        { environment: { ...process.env, ZCODE_MOCK_MALFORMED_JSON: "1" } },
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("zcode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("zcode"), model: "GLM-5.3" },
      });
      assert.equal(session.status, "ready");

      yield* adapter.stopSession(threadId);
    }),
  );
});
