// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  buildZcodeAppServerArgv,
  findZcodeOnPath,
  isZcodeNodeBundle,
  resolveZcodeCliPath,
} from "./executable.ts";

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

  it("flags ELECTRON_RUN_AS_NODE when spawning through our own runtime binary", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-exec-"));
    const cjs = NodePath.join(dir, "zcode.cjs");
    NodeFS.writeFileSync(cjs, "console.log('ok')\n");
    // The default node binary IS process.execPath in tests: the packaged
    // sidecar runs the same way, just with an Electron binary in its place.
    const argv = buildZcodeAppServerArgv({
      binaryPath: cjs,
      env: {},
      platform: "linux",
    });
    expect(argv.envExtras).toEqual({ ELECTRON_RUN_AS_NODE: "1" });

    // A custom ZCODE_NODE that is not our own binary gets no flag...
    const other = NodePath.join(dir, "other-node");
    NodeFS.writeFileSync(other, "#!/bin/sh\n");
    const custom = buildZcodeAppServerArgv({
      binaryPath: cjs,
      env: { ZCODE_NODE: other },
      platform: "linux",
    });
    expect(custom.envExtras).toBeUndefined();

    // ...unless the environment carries the Electron flag already.
    const inherited = buildZcodeAppServerArgv({
      binaryPath: cjs,
      env: { ZCODE_NODE: other, ELECTRON_RUN_AS_NODE: "1" },
      platform: "linux",
    });
    expect(inherited.envExtras).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
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
      const platform = yield* HostProcess.Platform;
      if (platform === "win32") return;

      const first = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-path-first-"));
      const second = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-path-second-"));
      const shadow = NodePath.join(first, "zcode");
      const executable = NodePath.join(second, "zcode");
      NodeFS.writeFileSync(shadow, "not executable\n", { mode: 0o644 });
      NodeFS.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

      expect(findZcodeOnPath("zcode", { PATH: `${first}:${second}` }, platform)).toBe(executable);
    }),
  );

  it("prefers a wrapper script on PATH when resolving default zcode", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-wrapper-"));
    const wrapper = NodePath.join(dir, "zcode");
    NodeFS.writeFileSync(wrapper, '#!/bin/sh\nexec node zcode.cjs "$@"\n', { mode: 0o755 });
    expect(resolveZcodeCliPath("zcode", { PATH: dir }, "linux")).toBe(wrapper);
  });

  it("attaches sibling zcode-builtin.json to envExtras when found", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-bundle-"));
    const glmDir = NodePath.join(root, "glm");
    const configDir = NodePath.join(root, "config", "provider");
    NodeFS.mkdirSync(glmDir, { recursive: true });
    NodeFS.mkdirSync(configDir, { recursive: true });
    const cjs = NodePath.join(glmDir, "zcode.cjs");
    const builtinJson = NodePath.join(configDir, "zcode-builtin.json");
    NodeFS.writeFileSync(cjs, "console.log('ok')\n");
    NodeFS.writeFileSync(builtinJson, "{}\n");

    const argv = buildZcodeAppServerArgv({
      binaryPath: cjs,
      env: { ZCODE_NODE: "/bin/node" },
      platform: "linux",
    });
    expect(argv.envExtras?.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(builtinJson);
  });

  it("expands tilde paths when binaryPath starts with ~/", () => {
    const home = NodeOS.homedir();
    const resolved = resolveZcodeCliPath("~/.local/bin/zcode", {}, "linux");
    expect(resolved).toBe(NodePath.join(home, ".local", "bin", "zcode"));
  });
});
