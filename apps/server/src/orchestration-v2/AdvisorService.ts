import {
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type OrchestratorMcpConsultAdvisorResult,
  type OrchestratorMcpDelegateTaskResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  historicalMessage,
  historyCost,
  renderHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const ADVISOR_TARGET = {
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
  options: [{ id: "effort", value: "medium" }],
} as const;

export interface ConsultAdvisorInput {
  readonly parentThreadId: ThreadId;
  readonly question: string;
  readonly brief: string;
  readonly includeTranscript: boolean;
  readonly timeoutMs?: number | undefined;
}

export type ConsultAdvisorResult = OrchestratorMcpConsultAdvisorResult;

export class AdvisorError extends Schema.TaggedError<AdvisorError>()("AdvisorError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const TRANSCRIPT_CONTEXT = "Transcript of the thread asking for advice, oldest first.";

const advisorPrompt = (input: ConsultAdvisorInput, transcript: string | undefined) =>
  [
    "You are an advisor. Answer the question for the agent that asked; do not change files.",
    `Question:\n${input.question}`,
    `Brief:\n${input.brief}`,
    ...(transcript === undefined ? [] : [transcript]),
  ].join("\n\n");

const toResult = (
  task: OrchestratorMcpDelegateTaskResult,
): Effect.Effect<ConsultAdvisorResult, AdvisorError> => {
  switch (task.status) {
    case "completed":
      return task.summary === null
        ? Effect.fail(new AdvisorError({ message: "The advisor finished without an answer." }))
        : Effect.succeed({ status: "answered", answer: task.summary });
    case "failed":
    case "cancelled":
    case "interrupted":
      return Effect.fail(
        new AdvisorError({
          message: `The advisor task ${task.status}${task.summary === null ? "." : `: ${task.summary}`}`,
        }),
      );
    default:
      return Effect.succeed({ status: "pending", taskId: task.taskId });
  }
};

export const consult = Effect.fn("AdvisorService.consult")(function* (input: ConsultAdvisorInput) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread?.threadId !== input.parentThreadId) {
    return yield* new AdvisorError({ message: "Only the calling thread can consult the advisor." });
  }
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const shell = yield* projections
    .getThreadShell(input.parentThreadId)
    .pipe(
      Effect.mapError(
        (cause) => new AdvisorError({ message: "Unable to read the calling thread.", cause }),
      ),
    );
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.mapError(
      (cause) => new AdvisorError({ message: "Unable to read server settings.", cause }),
    ),
  );
  if (
    !resolveProjectProviderInstanceEnabled(
      settings,
      shell?.projectId ?? null,
      ADVISOR_TARGET.providerInstanceId,
    )
  ) {
    return { status: "rejected", reason: "advisor_unavailable" } satisfies ConsultAdvisorResult;
  }

  let transcript: string | undefined;
  if (input.includeTranscript) {
    const { visibleTurnItems } = yield* projections
      .getThreadProjection(input.parentThreadId)
      .pipe(
        Effect.mapError(
          (cause) => new AdvisorError({ message: "Unable to read the thread transcript.", cause }),
        ),
      );
    const messages = visibleTurnItems.flatMap(({ item }) => historicalMessage(item) ?? []);
    const tokenCap = yield* handoffTokenCapConfig.pipe(
      Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
    );
    // Fit or reject: a trimmed transcript would let the advisor answer on partial context.
    if (historyCost(messages, TRANSCRIPT_CONTEXT) > tokenCap) {
      return { status: "rejected", reason: "transcript_too_long" } satisfies ConsultAdvisorResult;
    }
    transcript = renderHistory(messages, TRANSCRIPT_CONTEXT);
  }

  const delegation = yield* OrchestratorMcpService.OrchestratorMcpService;
  const task = yield* delegation
    .delegateTask(scope, {
      task: advisorPrompt(input, transcript),
      title: "Advisor",
      target: ADVISOR_TARGET,
      mode: "wait",
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
    .pipe(Effect.mapError((cause) => new AdvisorError({ message: cause.message, cause })));
  return yield* toResult(task);
});
