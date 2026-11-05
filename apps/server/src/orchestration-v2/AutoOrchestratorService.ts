import {
  type AutoOrchestratorTier,
  classifyPromptIntent,
  type GeminiEffort,
  stripRoutingTags,
} from "@t3tools/shared/autoOrchestrator/intentMatcher";
import {
  type AutoOrchestratorTierConfig,
  type ModelSelection,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const DEFAULT_AUTO_ORCHESTRATOR_TIER_CONFIG: AutoOrchestratorTierConfig = {
  tier1: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
  },
  tier2: {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-3.8-flash-high",
  },
  tier3: {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-3.8-flash-medium",
  },
  fallback: {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-3.8-flash-high",
  },
  enableAutoSkills: true,
  enableSmartStickiness: true,
};

export interface ResolveTurnSelectionInput {
  readonly threadId: ThreadId;
  readonly promptText: string;
  readonly tierConfig?: Partial<AutoOrchestratorTierConfig> | undefined;
  readonly availableProviderInstanceIds: ReadonlyArray<string>;
}

export interface ResolveTurnSelectionResult {
  readonly targetSelection: ModelSelection;
  readonly activeTier: AutoOrchestratorTier;
  readonly cleanedPrompt: string;
  readonly triggeredSkill?: string | undefined;
  readonly skillInstruction?: string | undefined;
  readonly reason: string;
}

export interface AutoOrchestratorServiceShape {
  readonly resolveTurnSelection: (
    input: ResolveTurnSelectionInput,
  ) => Effect.Effect<ResolveTurnSelectionResult>;
}

export class AutoOrchestratorService extends Context.Service<
  AutoOrchestratorService,
  AutoOrchestratorServiceShape
>()("t3/orchestration-v2/AutoOrchestratorService") {}

// Antigravity encodes Gemini effort in the model slug; other providers keep their configured model.
function withGeminiEffort(
  selection: ModelSelection,
  effort: GeminiEffort | undefined,
): ModelSelection {
  if (effort === undefined || selection.instanceId !== "antigravity") return selection;
  const mappedEffort = effort === "low" ? "medium" : effort;
  return { instanceId: selection.instanceId, model: `gemini-3.8-flash-${mappedEffort}` };
}

function skillInstructionFor(skillName: string): string {
  switch (skillName) {
    case "test-driven-development":
      return `[Auto-Orchestrator Protocol: Áp dụng kỹ năng test-driven-development (TDD)]\n- Viết test trước từ yêu cầu/spec (RED).\n- Viết code tối thiểu để pass (GREEN).\n- Tuyệt đối không sửa test hoặc assert giả tạo.`;
    case "systematic-debugging":
      return `[Auto-Orchestrator Protocol: Áp dụng kỹ năng systematic-debugging]\n- Không sửa mò (no guess-and-check).\n- Tái hiện lỗi -> Cô lập nguyên nhân gốc rễ -> Lập giả thuyết -> Sửa tối thiểu và kiểm chứng.`;
    case "code-review":
      return `[Auto-Orchestrator Protocol: Áp dụng kỹ năng code-review]\n- Rà soát trên 2 trục: Standards (chuẩn codebase) và Spec (yêu cầu nghiệp vụ).\n- Đánh giá kiến trúc Deep Module và tính toàn vẹn của mã.`;
    case "grilling":
      return `[Auto-Orchestrator Protocol: Áp dụng kỹ năng grilling]\n- Chất vấn phản biện sâu về kiến trúc, trade-off, và trường hợp biên trước khi code.`;
    default:
      return `[Auto-Orchestrator Protocol: Áp dụng kỹ năng ${skillName}]`;
  }
}

export const layer: Layer.Layer<AutoOrchestratorService> = Layer.succeed(AutoOrchestratorService, {
  resolveTurnSelection: Effect.fn("AutoOrchestratorService.resolveTurnSelection")(
    function* (input) {
      const config: AutoOrchestratorTierConfig = {
        ...DEFAULT_AUTO_ORCHESTRATOR_TIER_CONFIG,
        ...input.tierConfig,
      };

      const availableSet = new Set(input.availableProviderInstanceIds);
      const classification = classifyPromptIntent(input.promptText);
      const cleanedPrompt = stripRoutingTags(input.promptText);

      let chosenTier: AutoOrchestratorTier = classification.tier;
      let chosenSelection: ModelSelection = withGeminiEffort(
        chosenTier === 1 ? config.tier1 : chosenTier === 3 ? config.tier3 : config.tier2,
        classification.effort,
      );
      let reason = classification.reason;

      // Fallback safety check: Is the chosen provider instance available?
      if (!availableSet.has(chosenSelection.instanceId)) {
        if (availableSet.has(config.fallback.instanceId)) {
          chosenSelection = config.fallback;
          chosenTier = 2;
          reason = `Fallback: ${classification.reason} (Desired provider unavailable, routing to fallback)`;
        } else if (input.availableProviderInstanceIds.length > 0) {
          const firstAvailable = input.availableProviderInstanceIds[0];
          chosenSelection = {
            instanceId: ProviderInstanceId.make(firstAvailable),
            model: "default",
          };
          chosenTier = 2;
          reason = `Emergency Fallback: Routing to available provider ${firstAvailable}`;
        }
      }

      const skillInstruction =
        config.enableAutoSkills !== false && classification.triggeredSkill
          ? skillInstructionFor(classification.triggeredSkill)
          : undefined;

      return {
        targetSelection: chosenSelection,
        activeTier: chosenTier,
        cleanedPrompt,
        triggeredSkill: classification.triggeredSkill,
        skillInstruction,
        reason,
      };
    },
  ),
});
