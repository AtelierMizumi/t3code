import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TextGenerationError, type ModelSelection, type ZCodeSettings } from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { resolveZcodeModelId } from "../provider/Layers/ZCodeAdapter.ts";
import {
  handleBuiltinZcodeServerRequest,
  startZcodeProtocolClient,
  zcodeCreateSession,
} from "../provider/zcodeRuntime.ts";
import { readZcodeDesktopPlan } from "../provider/zcodeDesktopAuth.ts";

const ZCODE_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeZcodeTextGeneration = Effect.fn("makeZcodeTextGeneration")(function* (
  zcodeSettings: ZCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const runZcodeJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      let output = "";
      let resolveDone: (() => void) | undefined;
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const client = yield* startZcodeProtocolClient({
        binaryPath: zcodeSettings.binaryPath,
        cwd,
        environment,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: cause.message,
              cause,
            }),
        ),
      );

      client.setServerRequestHandler((request) => {
        handleBuiltinZcodeServerRequest(client, request);
      });
      client.setEventHandler((event) => {
        if (event.type === "model.streaming") {
          const payload =
            event.payload && typeof event.payload === "object"
              ? (event.payload as Record<string, unknown>)
              : {};
          if (payload.kind === "text_delta" && typeof payload.delta === "string") {
            output += payload.delta;
          }
        }
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.terminal"
        ) {
          resolveDone?.();
        }
      });

      const plan = readZcodeDesktopPlan(environment);
      const created = yield* zcodeCreateSession(client, {
        cwd,
        mode: "yolo",
        modelId: resolveZcodeModelId(modelSelection.model),
        providerId: plan?.providerId,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: cause.message,
              cause,
            }),
        ),
      );

      yield* Effect.tryPromise({
        try: () =>
          client.request("session/send", {
            sessionId: created.sessionId,
            content: `${prompt}\n\nReturn only JSON.`,
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      yield* Effect.promise(() => donePromise).pipe(
        Effect.timeoutOption(ZCODE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "ZCode text generation timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const trimmed = output.trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "ZCode returned empty output.",
        });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "ZCode returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "ZCode text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  return {
    generateCommitMessage: Effect.fn("ZCodeTextGeneration.generateCommitMessage")(
      function* (input) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const generated = yield* runZcodeJson({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt,
          outputSchemaJson: outputSchema,
          modelSelection: input.modelSelection,
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body,
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      },
    ),
    generatePrContent: Effect.fn("ZCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        changeRequestTemplate: input.changeRequestTemplate,
        policy: input.policy,
      });
      const generated = yield* runZcodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body,
      };
    }),
    generateBranchName: Effect.fn("ZCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runZcodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeFeatureBranchName(generated.branch) };
    }),
    generateThreadTitle: Effect.fn("ZCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runZcodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    }),
  } satisfies TextGeneration.TextGeneration["Service"];
});
