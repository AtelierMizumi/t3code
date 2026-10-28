// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  buildZcodeAppServerArgv,
  findZcodeOnPath,
  isZcodeNodeBundle,
  resolveZcodeCliPath,
} from "./ZCodeExecutable.ts";

describe("resolveZcodeCliPath", () => {
  it("prefers an explicit zcode.cjs path", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-exec-"));
    const cjs = NodePath.join(dir, "zcode.cjs");
    NodeFS.writeFileSync(cjs, "console.log('ok')\n");
    expect(resolveZcodeCliPath(cjs, {}, "linux")).toBe(cjs);
  });

  it("keeps an explicit missing path so the probe can fail clearly", () => {
    expect(resolveZcodeCliPath("/definitely/missing/zcode", {}, "linux")).toBe(
      "/definitely/missing/zcode",
    );
  });

  it("discovers the bundled CLI when the setting is the default name", () => {
    const resolved = resolveZcodeCliPath("zcode", {}, "linux");
    expect(resolved.endsWith("zcode.cjs") || resolved === "zcode").toBe(true);
  });

  it("builds an app-server argv that forces the desktop surface", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-exec-"));
    const cjs = NodePath.join(dir, "zcode.cjs");
    NodeFS.writeFileSync(cjs, "console.log('ok')\n");
    const argv = buildZcodeAppServerArgv({
      binaryPath: cjs,
      env: {},
      platform: "linux",
    });
    expect(isZcodeNodeBundle(cjs)).toBe(true);
    expect(argv.args).toEqual([cjs, "app-server", "--surface", "desktop"]);
  });

  it.effect("skips non-executable PATH entries that shadow a usable CLI", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform === "win32") return;

      const first = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-path-first-"));
      const second = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-path-second-"));
      const shadow = NodePath.join(first, "zcode");
      const executable = NodePath.join(second, "zcode");
      NodeFS.writeFileSync(shadow, "not executable\n", { mode: 0o644 });
      NodeFS.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

      expect(
        findZcodeOnPath("zcode", { PATH: [first, second].join(NodePath.delimiter) }, platform),
      ).toBe(executable);
    }),
  );

  it("recognizes node bundle extensions case-insensitively", () => {
    expect(isZcodeNodeBundle("/Applications/ZCode/app.ZCODE.CJS")).toBe(true);
  });
});
