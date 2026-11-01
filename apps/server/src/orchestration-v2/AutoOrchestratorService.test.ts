import { describe, expect, it } from "vite-plus/test";
import { ModelSelection, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  AutoOrchestratorService,
  DEFAULT_AUTO_ORCHESTRATOR_TIER_CONFIG,
  layer as AutoOrchestratorServiceLive,
} from "./AutoOrchestratorService.ts";

describe("AutoOrchestratorService", () => {
  const claudeSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
  };
  const geminiSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-3.8-flash-high",
  };
  const deepseekSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "orcarouter/deepseek/deepseek-v4-flash-free",
  };

  const defaultAvailable = ["claudeAgent", "antigravity", "opencode", "zcode"];

  it("routes explicit @claude tag override to Tier 1 and cleans prompt", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_1"),
        promptText: "@claude thiết kế spec cho module auth",
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection.instanceId).toBe("claudeAgent");
      expect(result.activeTier).toBe(1);
      expect(result.cleanedPrompt).toBe("thiết kế spec cho module auth");
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("routes explicit @zcode tag override to zcode provider and cleans prompt", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_zcode"),
        promptText: "@zcode giải quyết thuật toán này",
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection.instanceId).toBe("zcode");
      expect(result.targetSelection.model).toBe("GLM-5.3");
      expect(result.cleanedPrompt).toBe("giải quyết thuật toán này");
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("routes architectural intent to Tier 1 with auto-skill instruction", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_2"),
        promptText: "Hãy review lại PR và audit security của file này",
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection.instanceId).toBe("claudeAgent");
      expect(result.activeTier).toBe(1);
      expect(result.triggeredSkill).toBe("code-review");
      expect(result.skillInstruction).toContain("code-review");
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("routes coding & implementation intent to Tier 2 with TDD skill instruction", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_3"),
        promptText: "Implement tính năng lưu giỏ hàng với TDD",
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection.instanceId).toBe("antigravity");
      expect(result.activeTier).toBe(2);
      expect(result.triggeredSkill).toBe("test-driven-development");
      expect(result.skillInstruction).toContain("test-driven-development");
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("routes regex & utility intent to Tier 3", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_4"),
        promptText: "Viết giúp tôi regex bóc tách domain email",
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection.instanceId).toBe("opencode");
      expect(result.activeTier).toBe(3);
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("honors Smart Stickiness for general follow-up turns", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_5"),
        promptText: "Chạy thử xem sao, kết quả thế nào?",
        previousActiveSelection: claudeSelection,
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection.instanceId).toBe("claudeAgent");
      expect(result.activeTier).toBe(1);
      expect(result.reason).toContain("Smart Stickiness");
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("falls back to Tier 2 when the desired provider is unavailable", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_6"),
        promptText: "Hãy thiết kế kiến trúc hệ thống",
        availableProviderInstanceIds: ["antigravity"], // claudeAgent is unavailable!
      });

      expect(result.targetSelection.instanceId).toBe("antigravity");
      expect(result.reason).toContain("Fallback");
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));
});
