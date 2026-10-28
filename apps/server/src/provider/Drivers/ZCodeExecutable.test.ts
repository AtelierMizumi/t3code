import { describe, expect, it } from "vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  buildZcodeAppServerArgv,
  isZcodeNodeBundle,
  resolveZcodeCliPath,
} from "./ZCodeExecutable.ts";

describe("resolveZcodeCliPath", () => {
  it("prefers an explicit zcode.cjs path", () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "zcode-exec-"));
    const cjs = NodePath.join(dir, "zcode.cjs");
    NodeFs.writeFileSync(cjs, "console.log('ok')\n");
    expect(resolveZcodeCliPath(cjs)).toBe(cjs);
  });

  it("keeps an explicit missing path so the probe can fail clearly", () => {
    expect(resolveZcodeCliPath("/definitely/missing/zcode")).toBe("/definitely/missing/zcode");
  });

  it("discovers the bundled CLI when the setting is the default name", () => {
    const resolved = resolveZcodeCliPath("zcode");
    expect(resolved.endsWith("zcode.cjs") || resolved === "zcode").toBe(true);
  });

  it("builds an app-server argv that forces the desktop surface", () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "zcode-exec-"));
    const cjs = NodePath.join(dir, "zcode.cjs");
    NodeFs.writeFileSync(cjs, "console.log('ok')\n");
    const argv = buildZcodeAppServerArgv({ binaryPath: cjs });
    expect(isZcodeNodeBundle(cjs)).toBe(true);
    expect(argv.args).toEqual([cjs, "app-server", "--surface", "desktop"]);
  });
});
