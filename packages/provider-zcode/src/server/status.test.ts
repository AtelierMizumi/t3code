import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ZcodeSettings } from "../settings.ts";
import { checkZcodeProviderStatus } from "./status.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(ZcodeSettings)({ enabled: true });

function processHandle(stdout: string, code: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_101),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("checkZcodeProviderStatus", () => {
  it.effect("detects ready status with version when cli responds", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() => {
        return Effect.succeed(processHandle("0.17.0\n", 0));
      });

      const result = yield* checkZcodeProviderStatus(settings, {
        PATH: "/usr/bin",
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(NodeServices.layer),
      );

      expect(result.displayName).toBe("ZCode");
      expect(result.status).toBe("ready");
      expect(result.installed).toBe(true);
      expect(result.version).toBe("0.17.0");
      expect(result.models.length).toBeGreaterThanOrEqual(2);
      const glm53 = result.models.find((m) => m.slug === "GLM-5.3");
      expect(glm53?.capabilities?.optionDescriptors).toBeDefined();
      const effortOption = glm53?.capabilities?.optionDescriptors?.find((o) => o.id === "effort");
      expect(effortOption).toBeDefined();
      expect(effortOption?.type).toBe("select");
      if (effortOption?.type === "select") {
        expect(effortOption.options.map((o) => o.id)).toEqual(["low", "high", "max"]);
      }
    }),
  );

  it.effect("reports disabled status when disabled in settings", () =>
    Effect.gen(function* () {
      const disabledSettings = yield* Schema.decodeEffect(ZcodeSettings)({ enabled: false });
      const spawner = ChildProcessSpawner.make(() => {
        return Effect.succeed(processHandle("", 0));
      });

      const result = yield* checkZcodeProviderStatus(disabledSettings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(NodeServices.layer),
      );

      expect(result.status).toBe("disabled");
      expect(result.message).toContain("disabled");
    }),
  );
});
