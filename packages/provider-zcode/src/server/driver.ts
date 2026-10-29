import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { ZcodeSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ZcodeAdapterV2Driver, type ZcodeAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialZcodeProviderSnapshot,
  checkZcodeProviderStatus,
  enrichZcodeSnapshot,
} from "./status.ts";
import { makeZcodeTextGeneration } from "./textGeneration.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("zcode");

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type ZcodeDriverEnv = ZcodeAdapterV2DriverEnv | ChildProcessSpawner.ChildProcessSpawner;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ZcodeDriver: ProviderDriver<ZcodeSettings, ZcodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ZCode",
    supportsMultipleInstances: true,
  },
  configSchema: ZcodeSettings,
  defaultConfig: (): ZcodeSettings => decodeZcodeSettings({}),
  create: Effect.fn("ZcodeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies ZcodeSettings;

    const orchestrationAdapter = yield* ZcodeAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build ZCode orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeZcodeTextGeneration(effectiveConfig, processEnv, {
      cacheDir: host.paths.providerStatusCacheDir,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build ZCode text generation.",
            cause,
          }),
      ),
    );

    const checkProvider = checkZcodeProviderStatus(effectiveConfig, processEnv).pipe(
      Effect.map(stampIdentity),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ZcodeSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialZcodeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      enrichSnapshot: ({ snapshot: currentSnapshot }) =>
        enrichZcodeSnapshot(currentSnapshot).pipe(Effect.map(stampIdentity)),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build ZCode snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
