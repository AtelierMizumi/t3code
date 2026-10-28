import {
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ZCodeSettings,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildZcodeAppServerArgv,
  isZcodeNodeBundle,
  resolveZcodeCliPath,
} from "../Drivers/ZCodeExecutable.ts";
import { readZcodeDesktopPlan } from "../zcodeDesktopAuth.ts";

const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

const ZCODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "GLM-5.3", name: "GLM-5.3", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "GLM-5.2", name: "GLM-5.2", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "GLM-5-Turbo", name: "GLM-5-Turbo", isCustom: false, capabilities: EMPTY_CAPABILITIES },
];

export function buildInitialZcodeProviderSnapshot(
  zcodeSettings: ZCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
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
}

function zcodeModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ZCODE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

const runZcodeVersionCommand = (
  zcodeSettings: ZCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const argv = buildZcodeAppServerArgv({
      binaryPath: zcodeSettings.binaryPath,
      env: environment,
    });
    const versionArgs =
      argv.args[0] && isZcodeNodeBundle(argv.args[0]) ? [argv.args[0], "--version"] : ["--version"];
    const spawnCommand = yield* resolveSpawnCommand(argv.command, versionArgs, {
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

export const checkZcodeProviderStatus = Effect.fn("checkZcodeProviderStatus")(function* (
  zcodeSettings: ZCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const desktopPlan = readZcodeDesktopPlan(environment);
  const discoveredModels = desktopPlan
    ? desktopPlan.modelIds.map(
        (slug): ServerProviderModel => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        }),
      )
    : ZCODE_BUILT_IN_MODELS;
  const fallbackModels = zcodeModelsFromSettings(zcodeSettings.customModels, discoveredModels);

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

  const cliPath = resolveZcodeCliPath(zcodeSettings.binaryPath, environment);
  const versionResult = yield* runZcodeVersionCommand(zcodeSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("ZCode CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "ZCode CLI is not installed. Install the ZCode desktop app from https://zcode.z.ai."
          : "Failed to execute ZCode CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "ZCode CLI is installed but timed out while reporting its version.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

  if (versionOutput.code !== 0 && !cliPath.endsWith(".cjs")) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "ZCode CLI is not installed. Install the ZCode desktop app from https://zcode.z.ai.",
      },
    });
  }

  if (!desktopPlan?.authenticated) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "Sign in with the ZCode app (or `zcode login`) so T3 Code can use your Z.AI coding plan.",
      },
    });
  }

  return buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled: zcodeSettings.enabled,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});

export const enrichZcodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("ZCode version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
