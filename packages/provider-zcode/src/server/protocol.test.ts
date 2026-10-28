import { describe, expect, it } from "@effect/vitest";

import { selectZcodePermissionOptionId, zcodeToolShape } from "./adapter.ts";
import {
  mapRuntimeModeToZcodeMode,
  parseZcodeCreateResult,
  parseZcodeServerRequest,
  parseZcodeSessionEvent,
  resolveZcodeModelSlug,
} from "./rpc.ts";

describe("resolveZcodeModelSlug", () => {
  it("passes plain model ids through", () => {
    expect(resolveZcodeModelSlug("GLM-5.3")).toBe("GLM-5.3");
  });

  it("strips the zcode/ prefix", () => {
    expect(resolveZcodeModelSlug("zcode/GLM-5-Turbo")).toBe("GLM-5-Turbo");
  });

  it("treats default and blank slugs as the sentinel", () => {
    expect(resolveZcodeModelSlug("default")).toBeUndefined();
    expect(resolveZcodeModelSlug("  ")).toBeUndefined();
  });
});

describe("mapRuntimeModeToZcodeMode", () => {
  it("maps runtime modes to native session modes", () => {
    expect(mapRuntimeModeToZcodeMode("full-access", undefined)).toBe("yolo");
    expect(mapRuntimeModeToZcodeMode("auto-accept-edits", undefined)).toBe("edit");
    expect(mapRuntimeModeToZcodeMode(undefined, undefined)).toBe("build");
  });

  it("lets the plan interaction mode win", () => {
    expect(mapRuntimeModeToZcodeMode("full-access", "plan")).toBe("plan");
  });
});

describe("parseZcodeCreateResult", () => {
  it("reads the nested session envelope", () => {
    const parsed = parseZcodeCreateResult({
      session: { sessionId: "s-1", model: { modelId: "GLM-5.3", providerId: "builtin:zai" } },
      settings: {
        model: {
          current: { modelId: "GLM-5.3", providerId: "builtin:zai" },
          available: [{ ref: { modelId: "GLM-5.3", providerId: "builtin:zai" }, label: "GLM-5.3" }],
        },
      },
    });
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.modelId).toBe("GLM-5.3");
    expect(parsed.providerId).toBe("builtin:zai");
    expect(parsed.availableModels).toHaveLength(1);
  });

  it("returns an empty session id for malformed payloads", () => {
    expect(parseZcodeCreateResult(undefined).sessionId).toBe("");
  });
});

describe("parseZcodeSessionEvent / parseZcodeServerRequest", () => {
  it("parses session/event notifications", () => {
    const event = parseZcodeSessionEvent({
      sessionId: "s-1",
      seq: 3,
      type: "model.streaming",
      payload: { kind: "text_delta", delta: "hi" },
    });
    expect(event?.type).toBe("model.streaming");
    expect(event?.seq).toBe(3);
  });

  it("distinguishes server requests from notifications", () => {
    expect(
      parseZcodeServerRequest({ id: 7, method: "interaction/requestPermission", params: {} }),
    ).toMatchObject({ method: "interaction/requestPermission" });
    expect(parseZcodeServerRequest({ method: "session/event", params: {} })).toBeUndefined();
  });
});

describe("selectZcodePermissionOptionId", () => {
  const options = [
    { optionId: "opt-allow-always", kind: "allow_always" },
    { optionId: "opt-allow-once", kind: "allow_once" },
    { optionId: "opt-reject", kind: "reject_once" },
  ];

  it("maps T3 decisions onto native option kinds", () => {
    expect(selectZcodePermissionOptionId(options, "accept")).toBe("opt-allow-once");
    expect(selectZcodePermissionOptionId(options, "acceptForSession")).toBe("opt-allow-always");
    expect(selectZcodePermissionOptionId(options, "acceptAlways")).toBe("opt-allow-always");
    expect(selectZcodePermissionOptionId(options, "decline")).toBe("opt-reject");
  });

  it("returns undefined when the provider offers no matching option", () => {
    expect(
      selectZcodePermissionOptionId([{ optionId: "x", kind: "wat" }], "accept"),
    ).toBeUndefined();
  });
});

describe("zcodeToolShape", () => {
  it("classifies tools into turn item shapes", () => {
    expect(zcodeToolShape("bash")).toBe("command_execution");
    expect(zcodeToolShape("edit")).toBe("file_change");
    expect(zcodeToolShape("web_search")).toBe("dynamic_tool");
  });
});
