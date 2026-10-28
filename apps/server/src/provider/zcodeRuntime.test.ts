import { describe, expect, it } from "vitest";

import {
  mapRuntimeModeToZcodeMode,
  parseZcodeCreateResult,
  parseZcodeSessionEvent,
} from "./zcodeRuntime.ts";

describe("mapRuntimeModeToZcodeMode", () => {
  it("maps T3 runtime modes onto ZCode permission modes", () => {
    expect(mapRuntimeModeToZcodeMode("full-access", undefined)).toBe("yolo");
    expect(mapRuntimeModeToZcodeMode("auto-accept-edits", undefined)).toBe("edit");
    expect(mapRuntimeModeToZcodeMode("approval-required", undefined)).toBe("build");
    expect(mapRuntimeModeToZcodeMode("full-access", "plan")).toBe("plan");
  });
});

describe("parseZcodeCreateResult", () => {
  it("reads sessionId and available models from a create response", () => {
    const parsed = parseZcodeCreateResult({
      session: {
        sessionId: "sess_1",
        model: { modelId: "GLM-5.3", providerId: "builtin:zai-coding-plan" },
      },
      settings: {
        model: {
          current: { modelId: "GLM-5.3", providerId: "builtin:zai-coding-plan" },
          available: [
            {
              label: "GLM-5.3",
              ref: { modelId: "GLM-5.3", providerId: "builtin:zai-coding-plan" },
            },
          ],
        },
      },
    });
    expect(parsed.sessionId).toBe("sess_1");
    expect(parsed.modelId).toBe("GLM-5.3");
    expect(parsed.availableModels).toEqual([
      { modelId: "GLM-5.3", providerId: "builtin:zai-coding-plan", label: "GLM-5.3" },
    ]);
  });
});

describe("parseZcodeSessionEvent", () => {
  it("ignores malformed events", () => {
    expect(parseZcodeSessionEvent(null)).toBeUndefined();
    expect(parseZcodeSessionEvent({ type: "turn.started" })).toBeUndefined();
  });

  it("parses a session event", () => {
    expect(
      parseZcodeSessionEvent({
        sessionId: "sess_1",
        seq: 3,
        type: "model.streaming",
        payload: { kind: "text_delta", delta: "hi" },
      }),
    ).toEqual({
      sessionId: "sess_1",
      seq: 3,
      type: "model.streaming",
      payload: { kind: "text_delta", delta: "hi" },
    });
  });
});
