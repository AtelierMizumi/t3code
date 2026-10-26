import {
  type DeviceError,
  type DeviceHostId,
  type DeviceHostSummary,
  type DeviceId,
  type DevicePlatform,
  type DeviceSession,
  type DeviceSummary,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../../../config.ts";
import { ensureAgentDeviceShim } from "../../../device/AgentDeviceShim.ts";
import { nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";

import * as DeviceService from "../../../device/DeviceService.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit, DeviceToolkit } from "./tools.ts";

function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];
}

export function agentDeviceQuickStart(
  device: DeviceSummary,
  targetArgs = agentDeviceTargetArgs(device),
  command = "agent-device",
  cloud = false,
): string {
  const executable = /^[a-zA-Z0-9_./:-]+$/.test(command)
    ? command
    : "'" + command.replaceAll("'", "'\"'\"'") + "'";
  const target = targetArgs
    .map((arg) =>
      /^[a-zA-Z0-9_./:-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\"'\"'") + "'",
    )
    .join(" ");
  const platformNotes = cloud
    ? "This is an EAS Simulator session in the cloud. It bills the Expo account per minute until it stops, so call device_close with shutdown: true when you are done. It starts with no apps installed: install-from-source <url> installs a build from a URL (iOS needs a .tar.gz containing a .app), and install uploads one from this machine."
    : device.platform === "ios"
      ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
      : "The Android snapshot helper installs itself on first use.";
  return [
    `The user is watching ${device.name} (${device.version}) in the Device panel.`,
    `Drive it with ${executable}. Use this exact executable path; login shells may reset PATH. Always pass ${target}.`,
    "Typical loop:",
    `  ${executable} open <bundle-or-package-id> ${target}     # or: open <app> <deep-link-url>`,
    `  ${executable} snapshot -i ${target}                     # accessibility tree with @eN refs`,
    `  ${executable} click @e3 ${target}`,
    `  ${executable} fill @e5 "text" ${target}`,
    `  ${executable} screenshot /tmp/shot.png ${target}        # or call device_screenshot`,
    `  ${executable} install <app> <path-to-.app-or-.apk> ${target}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help for workflow guides and ${executable} <command> --help for flags.`,
    "Prefer agent-device for driving this device. simctl, adb, and xcrun remain available for anything it does not cover.",
    "For remote hosts, arrange builds, app installation, and any Metro reverse forwarding yourself. T3 provides discovery, streaming, and control only.",
    "Keep the returned --config and --session flags on every command. Other hosts can be used concurrently; opening one does not switch these commands.",
    platformNotes,
  ].join("\n");
}

const requireDeviceAccess = McpInvocationContext.requireThreadMcpCapability("device").pipe(
  Effect.mapError(
    () =>
      new DeviceToolUnavailableError({
        reason: "Agent device access is turned off for this environment.",
      }),
  ),
);

const hostName = (hosts: ReadonlyArray<DeviceHostSummary>, hostId: DeviceHostId) => {
  const label = hosts.find((host) => host.id === hostId)?.label;
  return label === undefined ? `hostId ${hostId}` : `'${label}' (hostId ${hostId})`;
};

/**
 * Device ids are unique per host, not across hosts: an Android AVD name can exist on two.
 * An explicit hostId decides; without one, the id has to name a single host.
 */
const selectByDeviceId = Effect.fn("handlers.selectByDeviceId")(function* <
  T extends { readonly hostId: DeviceHostId },
>(input: {
  readonly deviceId: DeviceId;
  readonly matches: ReadonlyArray<T>;
  readonly hostId: DeviceHostId | undefined;
  readonly hosts: Effect.Effect<ReadonlyArray<DeviceHostSummary>>;
  readonly missing: (hostId: DeviceHostId | undefined) => string;
}): Effect.fn.Return<T, DeviceToolUnavailableError> {
  const onHost = input.matches.filter(
    (match) => input.hostId === undefined || match.hostId === input.hostId,
  );
  const hostIds = [...new Set(onHost.map((match) => match.hostId))];
  if (hostIds.length === 1) return onHost.at(-1)!;
  const hosts = yield* input.hosts;
  const names = (ids: ReadonlyArray<DeviceHostId>) =>
    ids.map((id) => hostName(hosts, id)).join(", ");
  if (hostIds.length > 1) {
    return yield* new DeviceToolUnavailableError({
      reason: `Device ${input.deviceId} is on more than one host: ${names(hostIds)}. Pass hostId.`,
    });
  }
  const elsewhere = [...new Set(input.matches.map((match) => match.hostId))];
  return yield* new DeviceToolUnavailableError({
    reason:
      input.hostId !== undefined && elsewhere.length > 0
        ? `Device ${input.deviceId} is not on ${hostName(hosts, input.hostId)}. It is on ${names(elsewhere)}; pass that hostId.`
        : input.missing(input.hostId),
  });
});

const pickDevice = Effect.fn("handlers.pickDevice")(function* (
  state: {
    readonly hosts: ReadonlyArray<DeviceHostSummary>;
    readonly devices: ReadonlyArray<DeviceSummary>;
  },
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
): Effect.fn.Return<DeviceSummary, DeviceToolUnavailableError> {
  if (input.deviceId !== undefined) {
    const deviceId = input.deviceId;
    return yield* selectByDeviceId({
      deviceId,
      matches: state.devices.filter((device) => device.id === deviceId),
      hostId: input.hostId,
      hosts: Effect.succeed(state.hosts),
      missing: (hostId) =>
        `No device ${deviceId} on ${hostId === undefined ? "any host" : hostName(state.hosts, hostId)}. Call device_list for current ids.`,
    });
  }
  const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
  const candidates = state.devices.filter(
    (device) =>
      device.hostId === hostId &&
      (input.platform === undefined || device.platform === input.platform),
  );
  if (candidates.length === 0) {
    return yield* new DeviceToolUnavailableError({
      reason:
        input.platform === undefined
          ? "No simulators or emulators were found. Call device_list to see why."
          : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
    });
  }
  const platforms = new Set(candidates.map((device) => device.platform));
  if (input.platform === undefined && platforms.size > 1) {
    return yield* new DeviceToolUnavailableError({
      reason: "Both iOS and Android devices are available; pass platform or deviceId.",
    });
  }
  return candidates.find((device) => device.booted) ?? candidates[0]!;
});

const selectOpenSession = (
  devices: DeviceService.DeviceService["Service"],
  sessions: ReadonlyArray<DeviceSession>,
  deviceId: DeviceId,
  hostId: DeviceHostId | undefined,
) =>
  selectByDeviceId({
    deviceId,
    matches: sessions.filter((session) => session.deviceId === deviceId),
    hostId,
    hosts: devices.state.pipe(Effect.map((state) => state.hosts)),
    missing: () => `Device ${deviceId} is not open in this thread. Call device_open first.`,
  });

const toolError = (error: DeviceError | DeviceToolUnavailableError) => error;

const handlers = {
  device_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const hostId = input?.hostId;
      const open = state.sessions
        .filter((session) => session.threadId === scope.thread.threadId)
        .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
      return {
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => !hostId || id === hostId),
        ),
        hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
        devices: hostId
          ? state.devices.filter((device) => device.hostId === hostId)
          : state.devices,
        open,
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const target = yield* pickDevice(state, input);
      // Resolve consent and agent connectivity before booting or registering a session.
      if (!(yield* devices.agentReadinessIfSupported(target.hostId))) {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
        });
      }
      const session = yield* devices.open(
        {
          threadId: scope.thread.threadId,
          hostId: target.hostId,
          deviceId: target.id,
          platform: target.platform,
        },
        { workspaceRoot: yield* threadWorkspaceRoot(scope.thread.threadId) },
      );
      const after = yield* devices.state;
      const device =
        after.devices.find(
          (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
        ) ?? target;
      // Target the opened device: an EAS device and its agent-device daemon
      // exist only once its session runs, and Android ids change on boot.
      const agent = yield* devices.agentTarget({
        threadId: scope.thread.threadId,
        hostId: device.hostId,
        deviceId: device.id,
      });
      const cloud = after.hosts.some((host) => host.id === device.hostId && host.kind === "eas");
      const targetArgs = [
        ...agentDeviceTargetArgs({ ...device, id: agent.agentDeviceId }),
        ...agent.args,
      ];
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const shimDir = yield* ensureAgentDeviceShim({
        entryPath: yield* devices.agentCli,
        stateDir: config.stateDir,
      }).pipe(
        Effect.mapError(
          (error) =>
            new DeviceToolUnavailableError({
              reason:
                error._tag === "NodeRuntimeUnavailableError"
                  ? nodeRuntimeUnavailableMessage("Device automation")
                  : "Could not prepare the agent-device launcher.",
              cause: error,
            }),
        ),
      );
      const command = path.join(
        shimDir,
        platform === "win32" ? "agent-device.cmd" : "agent-device",
      );
      return {
        device,
        agentDevice: { command, targetArgs },
        quickStart: agentDeviceQuickStart(device, targetArgs, command, cloud),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const sessions = yield* devices.sessionsForThread(scope.thread.threadId);
      const target =
        input.deviceId === undefined
          ? sessions.findLast(
              (session) => input.hostId === undefined || session.hostId === input.hostId,
            )
          : yield* selectOpenSession(devices, sessions, input.deviceId, input.hostId);
      if (!target) {
        return yield* new DeviceToolUnavailableError({
          reason: "No device is open in this thread. Call device_open first.",
        });
      }
      const shot = yield* devices.screenshot(target);
      return {
        device: shot.device,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const deviceId = input.deviceId;
      const sessions =
        deviceId === undefined ? [] : yield* devices.sessionsForThread(scope.thread.threadId);
      const hostId =
        deviceId === undefined || !sessions.some((session) => session.deviceId === deviceId)
          ? input.hostId
          : (yield* selectOpenSession(devices, sessions, deviceId, input.hostId)).hostId;
      yield* devices.close({
        threadId: scope.thread.threadId,
        ...(hostId === undefined ? {} : { hostId }),
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
      });
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof DeviceToolkit.tools>;

export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452;
  return isPng
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

const { device_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(DeviceStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(DeviceScreenshotToolkit, {
  device_screenshot,
});
