// @effect-diagnostics nodeBuiltinImport:off - ZCode discovery is a synchronous Node executable boundary.
/**
 * Resolve the official ZCode CLI entry (`zcode.cjs` from the desktop app).
 *
 * The `zcode` wrapper on PATH is often an Electron launcher. Spawning that
 * from T3 Code opens the GUI instead of the stdio app-server, so discovery
 * prefers the bundled `zcode.cjs` and only falls back to a PATH binary when
 * it is actually a Node CLI.
 *
 * @module provider/Drivers/ZCodeExecutable
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const ZCODE_CJS_BASENAME = "zcode.cjs";

function existingFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return NodeFS.statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeElectronLauncher(path: string): boolean {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = NodeFS.openSync(path, "r");
    const prefix = Buffer.alloc(8_192);
    const bytesRead = NodeFS.readSync(fileDescriptor, prefix, 0, prefix.length, 0);
    const head = prefix.toString("utf8", 0, bytesRead);
    return (
      head.includes("electron") || head.includes("ELECTRON_IS_DEV") || head.includes("app.asar")
    );
  } catch {
    return false;
  } finally {
    if (fileDescriptor !== undefined) NodeFS.closeSync(fileDescriptor);
  }
}

function siblingCjsFromLauncher(launcherPath: string): string | undefined {
  const resolved = NodeFS.realpathSync.native(launcherPath);
  const dir = NodePath.dirname(resolved);
  const candidates = [
    NodePath.join(dir, "..", "lib", "zcode", "glm", ZCODE_CJS_BASENAME),
    NodePath.join(dir, "..", "lib", "ZCode", "glm", ZCODE_CJS_BASENAME),
    NodePath.join(dir, "glm", ZCODE_CJS_BASENAME),
    NodePath.join(dir, "..", "resources", "glm", ZCODE_CJS_BASENAME),
    NodePath.join(dir, "..", "..", "resources", "glm", ZCODE_CJS_BASENAME),
  ];
  for (const candidate of candidates) {
    const found = existingFile(NodePath.resolve(candidate));
    if (found) return found;
  }
  return undefined;
}

function wellKnownCjsPaths(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const home = NodeOS.homedir();
  const localAppData = env.LOCALAPPDATA?.trim();
  return [
    "/usr/lib/zcode/glm/zcode.cjs",
    "/usr/lib/ZCode/glm/zcode.cjs",
    "/opt/ZCode/resources/glm/zcode.cjs",
    "/opt/zcode/resources/glm/zcode.cjs",
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    ...(localAppData
      ? [NodePath.join(localAppData, "Programs", "ZCode", "resources", "glm", ZCODE_CJS_BASENAME)]
      : []),
    NodePath.join(
      home,
      "Applications",
      "ZCode.app",
      "Contents",
      "Resources",
      "glm",
      ZCODE_CJS_BASENAME,
    ),
  ];
}

export function findZcodeOnPath(
  binary: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const pathEnv = env.PATH ?? env.Path;
  if (!pathEnv) return undefined;
  const extensions = platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of pathEnv.split(NodePath.delimiter)) {
    for (const extension of extensions) {
      const found = existingFile(NodePath.join(dir, `${binary}${extension}`));
      if (!found) continue;
      if (platform === "win32") return found;
      try {
        NodeFS.accessSync(found, NodeFS.constants.X_OK);
        return found;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/**
 * Resolve a spawnable ZCode CLI path. Prefer the desktop-bundled `zcode.cjs`
 * so sessions use the same OAuth coding-plan path as the ZCode app.
 */
export function resolveZcodeCliPath(
  binaryPath: string | null | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const requested = binaryPath?.trim() || "zcode";
  const requestedFile = existingFile(requested);
  if (requestedFile) {
    if (
      requestedFile.endsWith(".cjs") ||
      requestedFile.endsWith(".js") ||
      requestedFile.endsWith(".mjs")
    ) {
      return requestedFile;
    }
    if (looksLikeElectronLauncher(requestedFile)) {
      return siblingCjsFromLauncher(requestedFile) ?? requestedFile;
    }
    return requestedFile;
  }

  const isDefaultName =
    requested === "zcode" || requested === "zcode.exe" || requested === "zcode.cmd";
  if (!isDefaultName) {
    return requested;
  }

  for (const candidate of wellKnownCjsPaths(env)) {
    const found = existingFile(candidate);
    if (found) return found;
  }

  const fromPath = findZcodeOnPath(requested === "zcode" ? "zcode" : requested, env, platform);
  if (fromPath) {
    if (looksLikeElectronLauncher(fromPath)) {
      return siblingCjsFromLauncher(fromPath) ?? fromPath;
    }
    return fromPath;
  }

  return requested;
}

export function isZcodeNodeBundle(path: string): boolean {
  const extension = NodePath.extname(path).toLowerCase();
  return extension === ".cjs" || extension === ".js" || extension === ".mjs";
}

export function resolveZcodeNodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ZCODE_NODE?.trim();
  if (explicit) return explicit;
  return process.execPath;
}

export function buildZcodeAppServerArgv(input: {
  readonly binaryPath: string | null | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const cliPath = resolveZcodeCliPath(input.binaryPath, input.env, input.platform);
  if (isZcodeNodeBundle(cliPath)) {
    return {
      command: resolveZcodeNodeBinary(input.env),
      args: [cliPath, "app-server", "--surface", "desktop"],
    };
  }
  return {
    command: cliPath,
    args: ["app-server", "--surface", "desktop"],
  };
}
