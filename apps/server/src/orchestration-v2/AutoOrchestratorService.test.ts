import { describe, expect, it } from "vite-plus/test";
import { ModelSelection, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  AutoOrchestratorService,
  layer as AutoOrchestratorServiceLive,
} from "./AutoOrchestratorService.ts";

describe("AutoOrchestratorService", () => {
  const claudeSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
  };
  const flashMediumSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-3.8-flash-medium",
  };

  const defaultAvailable = ["claudeAgent", "antigravity"];

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

  it("does not route on @zcode and keeps the prompt intact", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_zcode"),
        promptText: "@zcode giải quyết thuật toán này",
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection.instanceId).not.toBe("zcode");
      expect(result.cleanedPrompt).toBe("@zcode giải quyết thuật toán này");
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
      expect(result.targetSelection.model).toBe("gemini-3.8-flash-high");
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("uses medium Gemini effort for default coding prompts", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_default_effort"),
        promptText: "Xin chào, hôm nay thế nào?",
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection).toEqual({
        instanceId: ProviderInstanceId.make("antigravity"),
        model: "gemini-3.8-flash-medium",
      });
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("routes regex & utility intent to Tier 3", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const result = yield* service.resolveTurnSelection({
        threadId: ThreadId.make("thread_test_4"),
        promptText: "Viết giúp tôi regex bóc tách domain email",
        availableProviderInstanceIds: defaultAvailable,
      });

      expect(result.targetSelection).toEqual(flashMediumSelection);
      expect(result.activeTier).toBe(3);
    }).pipe(Effect.provide(AutoOrchestratorServiceLive), Effect.runPromise));

  it("resolves the same selection regardless of any previous selection", () =>
    Effect.gen(function* () {
      const service = yield* AutoOrchestratorService;
      const input = {
        threadId: ThreadId.make("thread_test_5"),
        promptText: "Chạy thử xem sao, kết quả thế nào?",
        availableProviderInstanceIds: defaultAvailable,
      };
      const first = yield* service.resolveTurnSelection(input);
      const second = yield* service.resolveTurnSelection({
        ...input,
        // @ts-expect-error previousActiveSelection was removed: selection is a pure function of the prompt
        previousActiveSelection: claudeSelection,
      });

      expect(second.targetSelection).toEqual(first.targetSelection);
      expect(second.activeTier).toBe(first.activeTier);
      expect(second.reason).not.toContain("Stickiness");
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
