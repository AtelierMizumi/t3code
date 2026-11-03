import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
} from "@t3tools/contracts";
import { DEFAULT_HANDOFF_TOKEN_CAP } from "@t3tools/provider-core/server/handoffBudget";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { AdvisorError, consult } from "./AdvisorService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const parentThreadId = ThreadId.make("thread-parent");
const projectId = ProjectId.make("project-1");
const taskId = NodeId.make("task-advisor");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-local"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "session-1",
    providerInstanceId: ProviderInstanceId.make("gemini"),
  },
  client: undefined,
};

const taskResult = (
  overrides: Partial<OrchestratorMcpDelegateTaskResult>,
): OrchestratorMcpDelegateTaskResult => ({
  taskId,
  childThreadId: ThreadId.make("thread-child"),
  childRunId: null,
  childNodeId: taskId,
  status: "running",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
  ...overrides,
});

const userMessage = (index: number, text: string) => ({
  item: {
    id: `item-${index}`,
    threadId: parentThreadId,
    runId: null,
    providerThreadId: null,
    status: "completed",
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    inputIntent: "turn_start",
    messageId: MessageId.make(`message-${index}`),
    text,
    attachments: [],
  },
});

const harness = (input: {
  readonly claudeEnabled: boolean;
  readonly transcript?: ReadonlyArray<string>;
  readonly delegateResult?: OrchestratorMcpDelegateTaskResult;
}) => {
  const delegated: OrchestratorMcpDelegateTaskInput[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      delegateTask: (_scope, delegateInput) => {
        delegated.push(delegateInput);
        return Effect.succeed(input.delegateResult ?? taskResult({}));
      },
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () =>
        Effect.succeed({ id: parentThreadId, projectId } as OrchestrationV2ThreadShell),
      getThreadProjection: () =>
        Effect.succeed({
          thread: { id: parentThreadId, projectId },
          visibleTurnItems: (input.transcript ?? []).map((text, index) => userMessage(index, text)),
        } as unknown as OrchestrationV2ThreadProjection),
    }),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: "claudeAgent",
          enabled: input.claudeEnabled,
        },
      },
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
  );
  return { delegated, layer };
};

it.effect("answers with the advisor's result when the wait ends on a completed task", () => {
  const { delegated, layer } = harness({
    claudeEnabled: true,
    transcript: ["We use a mutex around the queue."],
    delegateResult: taskResult({ status: "completed", summary: "The race is safe." }),
  });
  return Effect.gen(function* () {
    const result = yield* consult({
      parentThreadId,
      question: "Is this race condition safe?",
      brief: "Queue writes happen under a mutex.",
      includeTranscript: true,
    });
    expect(result).toEqual({ status: "answered", answer: "The race is safe." });
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({
      mode: "wait",
      target: {
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "medium" }],
      },
    });
    expect(delegated[0]?.task).toContain("Is this race condition safe?");
    expect(delegated[0]?.task).toContain("Queue writes happen under a mutex.");
    expect(delegated[0]?.task).toContain("We use a mutex around the queue.");
  }).pipe(Effect.provide(layer));
});

it.effect("returns the task id while the advisor is still working when the wait expires", () => {
  const { delegated, layer } = harness({
    claudeEnabled: true,
    delegateResult: taskResult({ status: "running", waitTimedOut: true }),
  });
  return Effect.gen(function* () {
    const result = yield* consult({
      parentThreadId,
      question: "Which index fits?",
      brief: "Postgres table with 10M rows.",
      includeTranscript: false,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ status: "pending", taskId });
    expect(delegated[0]?.timeoutMs).toBe(5_000);
    expect(delegated[0]?.task).not.toContain("Historical");
  }).pipe(Effect.provide(layer));
});

it.effect("rejects a transcript above the handoff cap before creating a task", () => {
  const { delegated, layer } = harness({
    claudeEnabled: true,
    transcript: ["x".repeat(DEFAULT_HANDOFF_TOKEN_CAP), "more"],
  });
  return Effect.gen(function* () {
    const result = yield* consult({
      parentThreadId,
      question: "Review this?",
      brief: "Long thread.",
      includeTranscript: true,
    });
    expect(result).toEqual({ status: "rejected", reason: "transcript_too_long" });
    expect(delegated).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { label: "failed", task: taskResult({ status: "failed", summary: "Provider crashed." }) },
  { label: "cancelled", task: taskResult({ status: "cancelled" }) },
  { label: "interrupted", task: taskResult({ status: "interrupted" }) },
  {
    label: "completed without a summary",
    task: taskResult({ status: "completed", summary: null }),
  },
])("fails instead of answering when the advisor task is $label", ({ task }) => {
  const { delegated, layer } = harness({ claudeEnabled: true, delegateResult: task });
  return Effect.gen(function* () {
    const error = yield* consult({
      parentThreadId,
      question: "Is this safe?",
      brief: "Brief.",
      includeTranscript: false,
    }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(AdvisorError);
    expect(delegated).toHaveLength(1);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a consult for a thread other than the caller's before creating a task", () => {
  const { delegated, layer } = harness({ claudeEnabled: true });
  return Effect.gen(function* () {
    const error = yield* consult({
      parentThreadId: ThreadId.make("thread-other"),
      question: "Is this safe?",
      brief: "Brief.",
      includeTranscript: false,
    }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(AdvisorError);
    expect(delegated).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("rejects when claudeAgent is disabled before creating a task", () => {
  const { delegated, layer } = harness({ claudeEnabled: false });
  return Effect.gen(function* () {
    const result = yield* consult({
      parentThreadId,
      question: "Is this safe?",
      brief: "Brief.",
      includeTranscript: false,
    });
    expect(result).toEqual({ status: "rejected", reason: "advisor_unavailable" });
    expect(delegated).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});
