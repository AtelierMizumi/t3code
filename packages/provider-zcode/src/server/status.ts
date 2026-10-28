import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ZcodeSettings } from "../settings.ts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

import { buildZcodeAppServerArgv, isZcodeNodeBundle } from "./executable.ts";
import { readZcodeDesktopPlan } from "./desktopAuth.ts";

export const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: false,
  supportsConversationRollback: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * ZCode Protocol evolves with the desktop app and is not a published API, so
 * no hard minimum is enforced; the version is surfaced for diagnostics.
 */
export const MINIMUM_ZCODE_VERSION: string | null = null;

const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {};

const ZCODE_BUILTIN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "GLM-5.3",
    name: "GLM-5.3",
    isCustom: false,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  },
  {
    slug: "GLM-5.2",
    name: "GLM-5.2",
    isCustom: false,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  },
  {
    slug: "GLM-5-Turbo",
    name: "GLM-5-Turbo",
    isCustom: false,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  },
];

export function zcodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(ZCODE_BUILTIN_MODELS, customModels ?? [], null);
}

function buildZcodeVersionArgv(
  binaryPath: string | null | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const appServer = buildZcodeAppServerArgv({ binaryPath, env, platform });
  const bundlePath = appServer.args[0];
  if (bundlePath !== undefined && isZcodeNodeBundle(bundlePath)) {
    // Node bundles take `node zcode.cjs --version`; asking the app-server for a version boots a server.
    return { command: appServer.command, args: [bundlePath, "--version"] };
  }
  return { command: appServer.command, args: ["--version"] };
}

const runZcodeVersionProbe = Effect.fn("ZcodeProviderStatus.runZcodeVersionProbe")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv,
) {
  const platform = yield* HostProcess.Platform;
  const argv = buildZcodeVersionArgv(zcodeSettings.binaryPath, environment, platform);
  const spawnCommand = yield* resolveSpawnCommand(argv.command, [...argv.args], {
    env: environment,
  });
  return yield* spawnAndCollect(
    argv.command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

export const buildInitialZcodeProviderSnapshot = Effect.fn(
  "ZcodeProviderStatus.buildInitialZcodeProviderSnapshot",
)(function* (zcodeSettings: ZcodeSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = zcodeModelsFromSettings(zcodeSettings.customModels);
  if (!zcodeSettings.enabled) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ZCode is disabled in T3 Code settings.",
      },
    });
  }
  return buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking ZCode CLI availability...",
    },
  });
});

export const checkZcodeProviderStatus = Effect.fn("checkZcodeProviderStatus")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  void cwd;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = zcodeModelsFromSettings(zcodeSettings.customModels);

  if (!zcodeSettings.enabled) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ZCode is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runZcodeVersionProbe(zcodeSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    const commandMissing = isCommandMissingCause(error);
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !commandMissing,
        version: null,
        status: commandMissing ? "error" : "warning",
        auth: { status: "unknown" },
        message: commandMissing
          ? "ZCode CLI is not installed. Install the ZCode desktop app from https://zcode.z.ai."
          : "Failed to run the ZCode CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "The ZCode CLI health check timed out.",
      },
    });
  }

  const probeOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${probeOutput.stdout}\n${probeOutput.stderr}`);
  const plan = readZcodeDesktopPlan(environment);
  const versionTooOld =
    version !== null &&
    MINIMUM_ZCODE_VERSION !== null &&
    compareSemverVersions(version, MINIMUM_ZCODE_VERSION) < 0;

  return buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models: fallbackModels,
    probe: {
      // A found-but-failing CLI is installed but unhealthy; report it as such.
      installed: true,
      version,
      status: versionTooOld ? "warning" : "ready",
      auth: {
        status:
          plan === null ? "unknown" : plan.authenticated ? "authenticated" : "unauthenticated",
      },
      ...(versionTooOld && MINIMUM_ZCODE_VERSION !== null
        ? {
            message: `ZCode ${version} is older than the tested minimum ${MINIMUM_ZCODE_VERSION}; sessions may fail.`,
          }
        : {}),
    },
  });
});

export const enrichZcodeSnapshot = (
  snapshot: ServerProviderDraft,
): Effect.Effect<ServerProviderDraft> => {
  // The static GLM catalog plus user custom models is the honest offline picture.
  return Effect.succeed(snapshot);
};
