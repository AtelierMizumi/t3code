import { describe, expect, it } from "vite-plus/test";
import {
  AUTO_ORCHESTRATOR_INSTANCE_ID,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { resolveDispatchSelection } from "./AutoOrchestratorLock.ts";
import { layer as AutoOrchestratorServiceLive } from "./AutoOrchestratorService.ts";

describe("resolveDispatchSelection", () => {
  const autoSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make(AUTO_ORCHESTRATOR_INSTANCE_ID),
    model: "auto",
  };
  const codexSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  };
  const claudeSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
  };
  const available = ["claudeAgent", "antigravity", "codex"];

  const run = (input: Parameters<typeof resolveDispatchSelection>[0]) =>
    resolveDispatchSelection(input).pipe(
      Effect.provide(AutoOrchestratorServiceLive),
      Effect.runPromise,
    );

  it("passes a non-auto command selection through unchanged", async () => {
    const result = await run({
      commandModelSelection: codexSelection,
      threadModelSelection: autoSelection,
      hasRuns: false,
      text: "@claude hello",
      availableProviderInstanceIds: available,
    });
    expect(result.modelSelection).toEqual(codexSelection);
    expect(result.text).toBe("@claude hello");
  });

  it("keeps the thread's concrete selection when the command asks for auto_orchestrator", async () => {
    const result = await run({
      commandModelSelection: autoSelection,
      threadModelSelection: codexSelection,
      hasRuns: true,
      text: "@claude hello",
      availableProviderInstanceIds: available,
    });
    expect(result.modelSelection).toEqual(codexSelection);
    expect(result.text).toBe("@claude hello");
  });

  it("resolves through the orchestrator while the thread is still on auto_orchestrator", async () => {
    const result = await run({
      commandModelSelection: autoSelection,
      threadModelSelection: autoSelection,
      hasRuns: false,
      text: "@claude thiết kế spec cho module auth",
      availableProviderInstanceIds: available,
    });
    expect(result.modelSelection?.instanceId).toBe("claudeAgent");
    expect(result.modelSelection).toEqual(claudeSelection);
    expect(result.text).toBe(
      "thiết kế spec cho module auth\n\n[Advisor] Call consult_advisor for this question before answering.",
    );
  });

  it("turns the @claude tag into an advisor instruction and keeps the intent tier model", async () => {
    const result = await run({
      commandModelSelection: autoSelection,
      threadModelSelection: autoSelection,
      hasRuns: false,
      text: "@claude is this race condition safe?",
      availableProviderInstanceIds: available,
    });
    expect(result.text).toBe(
      "is this race condition safe?\n\n[Advisor] Call consult_advisor for this question before answering.",
    );
    expect(result.text).not.toContain("@claude");
    expect(result.modelSelection?.instanceId).toBe("antigravity");
  });

  it("keeps the intent tier model for a @claude coding prompt instead of locking on Claude", async () => {
    const result = await run({
      commandModelSelection: autoSelection,
      threadModelSelection: autoSelection,
      hasRuns: false,
      text: "@claude fix this bug: server crash",
      availableProviderInstanceIds: available,
    });
    expect(result.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "gemini-3.8-flash-high",
    });
    expect(result.text).toBe(
      "fix this bug: server crash\n\n[Advisor] Call consult_advisor for this question before answering.",
    );
  });

  it("uses the thread's selection when the command carries none", async () => {
    const result = await run({
      commandModelSelection: undefined,
      threadModelSelection: codexSelection,
      hasRuns: true,
      text: "hi",
      availableProviderInstanceIds: available,
    });
    expect(result.modelSelection).toEqual(codexSelection);
    expect(result.text).toBe("hi");
  });
});
