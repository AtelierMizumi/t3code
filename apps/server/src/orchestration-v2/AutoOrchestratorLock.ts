import { AUTO_ORCHESTRATOR_INSTANCE_ID, type ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AutoOrchestratorService } from "./AutoOrchestratorService.ts";

export interface ResolveDispatchInput {
  readonly commandModelSelection: ModelSelection | undefined;
  readonly threadModelSelection: ModelSelection;
  readonly hasRuns: boolean;
  readonly text: string;
  readonly availableProviderInstanceIds: ReadonlyArray<string>;
}

export interface ResolveDispatchResult {
  readonly modelSelection: ModelSelection | undefined;
  readonly text: string;
  readonly skillInstruction?: string | undefined;
  readonly reason: string;
}

// resolveTurnSelection requires a threadId but does not read it; the lock decision is thread-agnostic.
const UNUSED_THREAD_ID = ThreadId.make("auto-orchestrator-lock");

export const resolveDispatchSelection = Effect.fn("AutoOrchestrator.resolveDispatchSelection")(
  function* (input: ResolveDispatchInput) {
    const { commandModelSelection, threadModelSelection } = input;

    if (commandModelSelection === undefined) {
      return {
        modelSelection: threadModelSelection,
        text: input.text,
        reason: "No command selection",
      };
    }
    if (commandModelSelection.instanceId !== AUTO_ORCHESTRATOR_INSTANCE_ID) {
      return {
        modelSelection: commandModelSelection,
        text: input.text,
        reason: "Explicit selection",
      };
    }
    if (threadModelSelection.instanceId !== AUTO_ORCHESTRATOR_INSTANCE_ID) {
      return {
        modelSelection: threadModelSelection,
        text: input.text,
        reason: "Thread locked to concrete selection",
      };
    }

    const service = yield* AutoOrchestratorService;
    const resolved = yield* service.resolveTurnSelection({
      threadId: UNUSED_THREAD_ID,
      promptText: input.text,
      availableProviderInstanceIds: input.availableProviderInstanceIds,
    });
    return {
      modelSelection: resolved.targetSelection,
      text: resolved.cleanedPrompt,
      skillInstruction: resolved.skillInstruction,
      reason: resolved.reason,
    } satisfies ResolveDispatchResult;
  },
);
