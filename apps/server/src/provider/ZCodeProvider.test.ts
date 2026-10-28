// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ZCodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkZcodeProviderStatus } from "./ZCodeProvider.ts";

const decodeZcodeSettings = Schema.decodeSync(ZCodeSettings);

it.layer(NodeServices.layer)("checkZcodeProviderStatus", (it) => {
  it.effect("reports an executable nonzero version probe as installed but unhealthy", () =>
    Effect.gen(function* () {
      const storage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-provider-"));
      const cli = NodePath.join(storage, "zcode.cjs");
      NodeFS.writeFileSync(cli, "process.exit(7);\n");

      try {
        const snapshot = yield* checkZcodeProviderStatus(
          decodeZcodeSettings({ enabled: true, binaryPath: cli }),
          { ZCODE_STORAGE_DIR: storage },
        );

        assert.equal(snapshot.installed, true);
        assert.equal(snapshot.status, "error");
        assert.equal(snapshot.message, "Failed to execute ZCode CLI health check.");
      } finally {
        NodeFS.rmSync(storage, { recursive: true, force: true });
      }
    }),
  );
});
