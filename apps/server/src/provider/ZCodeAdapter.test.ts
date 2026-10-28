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
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  ZCodeSettings,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeZcodeAdapter } from "./ZCodeAdapter.ts";

const decodeZcodeSettings = Schema.decodeSync(ZCodeSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/zcode-mock-app-server.mjs");

const zcodeAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-zcode-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

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

      yield* adapter.stopSession(threadId);
    }),
  );
});
