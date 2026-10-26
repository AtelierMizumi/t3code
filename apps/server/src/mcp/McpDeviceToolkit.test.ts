import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeviceHostUnavailableError,
  DeviceId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-device-test");
const threadId = ThreadId.make("thread-device-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  requestNamespace: "provider-session-device-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-device-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const device = {
  hostId: "local",
  id: "UDID-1",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};
const state = {
  hosts: [
    {
      id: "local",
      kind: "local" as const,
      label: "This machine",
      platforms: [
        { platform: "ios" as const, available: true },
        { platform: "android" as const, available: false, reason: "No SDK" },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready" as const,
  hostStatuses: { local: { status: "ready" as const } },
  devices: [device],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
const png = new Uint8Array(24);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
new DataView(png.buffer).setUint32(12, 0x49484452);
new DataView(png.buffer).setUint32(16, 1206);
new DataView(png.buffer).setUint32(20, 2622);

const unused = Effect.die("not used");
const readiness = {
  hostId: "local",
  nodePath: process.execPath,
  hub: { origin: "http://hub.test" },
  devices: {
    list: unused,
    boot: () => unused,
    attach: () => unused,
    shutdown: () => unused,
    screenshot: () => unused,
  },
  run: () => unused,
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  agentDevice: null,
};
const layerProjectsMock = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const layerDeviceServiceMock = Layer.mock(DeviceService.DeviceService)({
  state: Effect.succeed(state),
  list: Effect.succeed(state),
  agentReadinessIfSupported: () => Effect.succeed(readiness),
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      hostId: "local",
      deviceId: input.deviceId,
      platform: input.platform,
      openedAt: "2026-09-08T00:00:00.000Z",
    }),

  sessionsForThread: (id) =>
    Effect.succeed(
      id === threadId
        ? [
            {
              threadId,
              hostId: "local",
              deviceId: DeviceId.make("UDID-1"),
              platform: "ios" as const,
              openedAt: "2026-09-08T00:00:00.000Z",
            },
          ]
        : [],
    ),
  screenshot: () => Effect.succeed({ device, png }),
  close: () => Effect.void,
  testHost: () => Effect.die("not used"),
  // As for an EAS device, agent-device knows the device by a different id than T3.
  agentTarget: () =>
    Effect.succeed({
      agentDeviceId: "SIM-UDID",
      session: "thread-device",
      args: ["--config", "/host.json", "--session", "thread-device"],
    }),
  agentLauncher: ({ targetArgs }) =>
    Effect.succeed(`/state/device/targets/thread-device/${targetArgs.join("_")}/agent-device`),
});

const layerTest = McpHttpServer.layerDeviceToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(layerDeviceServiceMock),
  Layer.provide(layerProjectsMock),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("registers the device tools and returns the screenshot as image content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name).toSorted();
      expect(names).toEqual(["device_close", "device_list", "device_open", "device_screenshot"]);

      const callWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities));

      const opened = yield* server
        .callTool({ name: "device_open", arguments: { platform: "ios" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(opened.isError).toBe(false);
      const openedContent = opened.structuredContent as {
        agentDevice: { command: string; targetArgs: ReadonlyArray<string>; session: string };
        quickStart: string;
      };
      // Callers that pass the target flags, like test-t3-mobile's pair-client.sh, keep working.
      expect(openedContent.agentDevice).toMatchObject({
        targetArgs: [
          "--platform",
          "ios",
          "--udid",
          "SIM-UDID",
          "--config",
          "/host.json",
          "--session",
          "thread-device",
        ],
        session: "thread-device",
      });
      expect(openedContent.quickStart).toContain(
        `${openedContent.agentDevice.command} snapshot -i`,
      );
      // The launcher selects the device by agent-device's id for it, not T3's.
      expect(openedContent.agentDevice.command).toBe(
        "/state/device/targets/thread-device/--platform_ios_--udid_SIM-UDID_--config_/host.json_--session_thread-device/agent-device",
      );

      const shot = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-1" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(shot.isError).toBe(false);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
      });

      const foreign = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-2" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(foreign.isError).toBe(true);
      expect(foreign.content.map((entry) => entry.type)).toEqual(["text"]);

      const denied = yield* server
        .callTool({ name: "device_list", arguments: {} })
        .pipe(callWith(["preview"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(denied.isError).toBe(true);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("rejects unavailable agent access before booting or opening a device", () => {
  const layerUnavailable = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentReadinessIfSupported: () =>
      Effect.fail(
        new DeviceHostUnavailableError({ hostId: "local", reason: "Agent access is disabled." }),
      ),
    open: () => Effect.die("Must not boot or register a device when agent access fails"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "device_open", arguments: { platform: "ios" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Agent access is disabled."),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(layerUnavailable),
        Layer.provide(layerProjectsMock),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

describe("device targeting across hosts", () => {
  const macHost = {
    id: "mac-mini",
    kind: "ssh" as const,
    label: "Mac Mini",
    platforms: [
      { platform: "ios" as const, available: true },
      { platform: "android" as const, available: true },
    ],
    hubInstalled: true,
    agentDeviceInstalled: true,
  };
  const macIphone = { ...device, hostId: "mac-mini", id: "MAC-UDID" };
  const localPixel = {
    hostId: "local",
    id: "Pixel_10",
    platform: "android" as const,
    name: "Pixel 10",
    version: "Android 16",
    booted: false,
    physical: false,
  };
  const macPixel = { ...localPixel, hostId: "mac-mini" };
  const multiHostState = {
    ...state,
    hosts: [...state.hosts, macHost],
    hostStatuses: {
      local: { status: "ready" as const },
      "mac-mini": { status: "ready" as const },
    },
    devices: [device, macIphone, localPixel, macPixel],
  };
  const session = (hostId: string, deviceId: string, platform: "ios" | "android") => ({
    threadId,
    hostId,
    deviceId: DeviceId.make(deviceId),
    platform,
    openedAt: "2026-09-08T00:00:00.000Z",
  });

  const run = <A, E>(
    sessions: ReadonlyArray<ReturnType<typeof session>>,
    program: (calls: {
      readonly opened: Array<{ hostId: string; deviceId: string }>;
      readonly closed: Array<{ hostId?: string | undefined; deviceId?: string | undefined }>;
      readonly call: (
        name: string,
        args: Record<string, unknown>,
      ) => Effect.Effect<
        McpSchema.CallToolResult,
        McpSchema.InternalError | McpSchema.InvalidParams,
        McpServer.McpServer
      >;
    }) => Effect.Effect<A, E, McpServer.McpServer>,
  ) => {
    const opened: Array<{ hostId: string; deviceId: string }> = [];
    const closed: Array<{ hostId?: string | undefined; deviceId?: string | undefined }> = [];
    const layerDevices = Layer.mock(DeviceService.DeviceService)({
      state: Effect.succeed(multiHostState),
      list: Effect.succeed(multiHostState),
      agentReadinessIfSupported: () => Effect.succeed(readiness),
      open: (input) =>
        Effect.sync(() => {
          opened.push({ hostId: input.hostId ?? "local", deviceId: input.deviceId });
          return session(input.hostId ?? "local", input.deviceId, input.platform);
        }),
      sessionsForThread: () => Effect.succeed(sessions),
      screenshot: (target) =>
        Effect.succeed({
          device:
            multiHostState.devices.find(
              (candidate) => candidate.hostId === target.hostId && candidate.id === target.deviceId,
            ) ?? device,
          png,
        }),
      close: (input) =>
        Effect.sync(() => {
          closed.push({ hostId: input.hostId, deviceId: input.deviceId });
        }),
      agentTarget: () =>
        Effect.succeed({
          agentDeviceId: "MAC-UDID",
          session: "thread-device",
          args: ["--config", "/mac.json", "--session", "thread-device"],
        }),
      agentLauncher: () => Effect.succeed("/state/device/targets/thread-device/agent-device"),
    });
    const call = (name: string, args: Record<string, unknown>) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) => server.callTool({ name, arguments: args })),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    return program({ opened, closed, call }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(layerDevices),
          Layer.provide(layerProjectsMock),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  };
  const text = (result: McpSchema.CallToolResult) =>
    result.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");

  it.effect("opens a device id that exists only on another host", () =>
    run([], ({ opened, call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_open", { deviceId: "MAC-UDID" });
        expect(text(result)).not.toContain("No device");
        expect(result.isError).toBe(false);
        expect(opened).toEqual([{ hostId: "mac-mini", deviceId: "MAC-UDID" }]);
      }),
    ),
  );

  it.effect("refuses a device id that exists on two hosts and names both", () =>
    run([], ({ opened, call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_open", { deviceId: "Pixel_10" });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("hostId local");
        expect(text(result)).toContain("hostId mac-mini");
        expect(opened).toEqual([]);
      }),
    ),
  );

  it.effect("keeps an explicit hostId and says which host has the device", () =>
    run([], ({ opened, call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_open", { deviceId: "MAC-UDID", hostId: "local" });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("hostId mac-mini");
        expect(opened).toEqual([]);
      }),
    ),
  );

  it.effect("screenshots an open device by id on whichever host it is on", () =>
    run([session("mac-mini", "MAC-UDID", "ios")], ({ call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_screenshot", { deviceId: "MAC-UDID" });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({ device: { hostId: "mac-mini" } });
      }),
    ),
  );

  it.effect("says why device_screenshot failed instead of a generic error", () =>
    run([session("mac-mini", "MAC-UDID", "ios")], ({ call }) =>
      Effect.gen(function* () {
        const wrongHost = yield* call("device_screenshot", {
          deviceId: "MAC-UDID",
          hostId: "local",
        });
        expect(wrongHost.isError).toBe(true);
        expect(text(wrongHost)).toContain("It is on 'Mac Mini' (hostId mac-mini)");
      }),
    ),
  );

  it.effect("tells an agent with no open device to call device_open before a screenshot", () =>
    run([], ({ call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_screenshot", {});
        expect(result.isError).toBe(true);
        expect(text(result)).toBe("No device is open in this thread. Call device_open first.");
        expect(result.structuredContent).toMatchObject({
          error: { _tag: "DeviceToolUnavailableError" },
        });
      }),
    ),
  );

  it.effect("refuses to close an id open on two hosts instead of closing both", () =>
    run(
      [session("local", "Pixel_10", "android"), session("mac-mini", "Pixel_10", "android")],
      ({ closed, call }) =>
        Effect.gen(function* () {
          const result = yield* call("device_close", { deviceId: "Pixel_10" });
          expect(result.isError).toBe(true);
          expect(text(result)).toContain("hostId mac-mini");
          expect(closed).toEqual([]);
        }),
    ),
  );
});
