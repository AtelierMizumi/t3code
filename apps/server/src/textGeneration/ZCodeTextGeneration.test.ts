// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ZCodeSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeZcodeTextGeneration } from "./ZCodeTextGeneration.ts";

const decodeZcodeSettings = Schema.decodeSync(ZCodeSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/zcode-mock-app-server.mjs");

it.layer(NodeServices.layer)("ZCodeTextGeneration", (it) => {
  it.effect("cancels unexpected interaction requests and completes generation", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeZcodeTextGeneration(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
        { ...process.env, ZCODE_MOCK_TEXTGEN_REQUEST_PERMISSION: "1" },
      );

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Summarize this thread",
        modelSelection: createModelSelection(ProviderInstanceId.make("zcode"), "GLM-5.3"),
      });

      assert.equal(generated.title, "ZCode title");
    }),
  );

  it.effect("surfaces turn.failed instead of decoding partial output as success", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeZcodeTextGeneration(
        decodeZcodeSettings({ binaryPath: mockAgentPath, enabled: true }),
        { ...process.env, ZCODE_MOCK_TURN_FAILED: "1" },
      );

      const error = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Summarize this thread",
          modelSelection: createModelSelection(ProviderInstanceId.make("zcode"), "GLM-5.3"),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TextGenerationError");
      assert.equal(error.detail, "mock generation failed");
    }),
  );
});
