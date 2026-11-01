import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";

export const AUTO_ORCHESTRATOR_INSTANCE_ID = "auto_orchestrator" as const;
export const AUTO_ORCHESTRATOR_MODEL_SLUG = "hybrid-router" as const;

export const AutoOrchestratorTierConfig = Schema.Struct({
  tier1: ModelSelection,
  tier2: ModelSelection,
  tier3: ModelSelection,
  fallback: ModelSelection,
  enableAutoSkills: Schema.optionalKey(Schema.Boolean),
  enableSmartStickiness: Schema.optionalKey(Schema.Boolean),
});
export type AutoOrchestratorTierConfig = typeof AutoOrchestratorTierConfig.Type;
