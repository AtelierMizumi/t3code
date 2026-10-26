// @effect-diagnostics preferSchemaOverJson:off - JSON string literals embed paths safely into generated JavaScript.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SHIM_DIR = "device/bin";
const TARGETS_DIR = "device/targets";
const STALE_RUNTIME =
  "This agent-device command is out of date because T3 Code moved or updated its runtime. Call device_open again for a fresh one.";

const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// Help needs no device, and agent-device reads --config even for help, so help gets no bound flags.
const launcherSource = (node: string, entryPath: string, boundArgs: ReadonlyArray<string>) =>
  `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const entry = ${JSON.stringify(entryPath)};
const bound = ${JSON.stringify(boundArgs)};
const args = process.argv.slice(2);
const informational = args.length === 0 || ["help", "--help", "-h", "--version", "version"].includes(args[0]) || args.includes("--help") || args.includes("-h");
const command = [...args];
if (!informational) for (let index = 0; index + 1 < bound.length; index += 2) if (!args.includes(bound[index])) command.push(bound[index], bound[index + 1]);
const hasValue = flag => { const index = command.indexOf(flag); return index >= 0 && !!command[index + 1] && !command[index + 1].startsWith("--"); };
if (!informational && !(hasValue("--config") && hasValue("--session"))) {
  console.error("Call device_open first and run the agent-device command it returns.");
  process.exit(1);
}
if (!existsSync(entry)) {
  console.error(${JSON.stringify(STALE_RUNTIME)});
  process.exit(1);
}
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;
const child = spawn(${JSON.stringify(node)}, [entry, ...command], { stdio: "inherit", env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
`;

/** Writes a launcher into `dir` and returns the executable agents run. */
const writeLauncher = Effect.fn("AgentDeviceShim.writeLauncher")(function* (input: {
  readonly dir: string;
  readonly entryPath: string;
  readonly boundArgs: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const node = yield* resolveNodeExecutable("Device automation");
  yield* fs.makeDirectory(input.dir, { recursive: true });
  const launcherPath = path.join(input.dir, "agent-device-launcher.mjs");
  yield* fs.writeFileString(launcherPath, launcherSource(node, input.entryPath, input.boundArgs));
  if (platform === "win32") {
    const script = `@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\nif not exist "${node}" (echo ${STALE_RUNTIME} 1>&2 & exit /b 1)\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${node}" "${launcherPath}" %*\r\n`;
    const scriptPath = path.join(input.dir, "agent-device.cmd");
    yield* fs.writeFileString(scriptPath, script);
    return scriptPath;
  }
  const script = `#!/bin/sh\n[ -x ${quoteShell(node)} ] || { echo ${quoteShell(STALE_RUNTIME)} >&2; exit 1; }\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quoteShell(node)} ${quoteShell(launcherPath)} "$@"\n`;
  const scriptPath = path.join(input.dir, "agent-device");
  yield* fs.writeFileString(scriptPath, script);
  yield* fs.chmod(scriptPath, 0o755);
  return scriptPath;
});

/** The unbound launcher: every call needs the device's target flags. */
export const ensureAgentDeviceShim = Effect.fn("AgentDeviceShim.ensure")(function* (input: {
  readonly entryPath: string;
  readonly stateDir: string;
}) {
  const path = yield* Path.Path;
  const shimDir = path.join(input.stateDir, SHIM_DIR);
  yield* writeLauncher({ dir: shimDir, entryPath: input.entryPath, boundArgs: [] });
  return shimDir;
});

/**
 * A launcher for one agent-device session with its target flags built in, so
 * agents pass none, and a shell that does not word-split a variable cannot mangle them.
 */
export const bindAgentDeviceLauncher = Effect.fn("AgentDeviceShim.bind")(function* (input: {
  readonly entryPath: string;
  readonly stateDir: string;
  readonly session: string;
  readonly targetArgs: ReadonlyArray<string>;
}) {
  const path = yield* Path.Path;
  return yield* writeLauncher({
    dir: path.join(input.stateDir, TARGETS_DIR, input.session),
    entryPath: input.entryPath,
    boundArgs: input.targetArgs,
  });
});
