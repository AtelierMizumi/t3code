import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { TextGenerationError } from "@t3tools/contracts";
import type { ZcodeSettings } from "../settings.ts";

import {
  handleBuiltinZcodeServerRequest,
  makeZcodeRpcConnection,
  parseZcodeServerRequest,
  rejectUnhandledZcodeServerRequest,
  resolveZcodeModelSlug,
  zcodeCreateSession,
  zcodeRecordField,
  zcodeRecordString,
  type ZcodeRpcConnection,
} from "./rpc.ts";
import { buildZcodeProviderConfigEnv, ZCODE_API_TEMPLATE_PROVIDER_ID } from "./desktopAuth.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

const ZCODE_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Drain the ephemeral session until its turn settles. Background helpers run
 * with no orchestrator attached, so interaction requests are auto-declined:
 * the CLI must never wait on an answer that will not come.
 */
const drainUntilTerminal = Effect.fn("ZcodeTextGeneration.drainUntilTerminal")(function* (
  connection: ZcodeRpcConnection,
) {
  let output = "";
  let terminalFailure: string | undefined;
  while (true) {
    const record = yield* Queue.take(connection.events);
    const serverRequest = parseZcodeServerRequest(record);
    if (serverRequest !== undefined) {
      const handled = yield* handleBuiltinZcodeServerRequest(connection, serverRequest);
      if (!handled) {
        yield* rejectUnhandledZcodeServerRequest(connection, serverRequest).pipe(Effect.ignore);
      }
      continue;
    }
    if (zcodeRecordString(record, "method") !== "session/event") continue;
    const rawParams = zcodeRecordField(record, "params");
    const params: Record<string, unknown> = Predicate.isObject(rawParams) ? rawParams : {};
    const type = zcodeRecordString(params, "type");
    const payload = Predicate.isObject(params.payload) ? params.payload : {};
    if (type === "model.streaming") {
      const kind = zcodeRecordString(payload, "kind") ?? "";
      const delta = zcodeRecordString(payload, "delta");
      if ((kind === "text_delta" || kind === "") && typeof delta === "string") {
        output += delta;
      }
      continue;
    }
    if (type === "turn.failed") {
      const error = Predicate.isObject(payload.error) ? payload.error : {};
      terminalFailure =
        zcodeRecordString(error, "message") ??
        zcodeRecordString(payload, "message") ??
        "ZCode turn failed.";
      return { output, terminalFailure };
    }
    if (type === "turn.completed" || type === "turn.terminal") {
      return { output, terminalFailure: undefined };
    }
  }
});

export const makeZcodeTextGeneration = Effect.fn("makeZcodeTextGeneration")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly cacheDir?: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const apiKey = zcodeSettings.apiKey?.trim() ?? "";
  const providerEnv: NodeJS.ProcessEnv = {
    ...environment,
    ...(apiKey && options?.cacheDir
      ? buildZcodeProviderConfigEnv({
          cacheDir: options.cacheDir,
          apiKey,
          env: environment,
        })
      : {}),
  };

  const runZcodeJson: TextGenerationOperations.Runner = Effect.fn(
    "ZcodeTextGeneration.runZcodeJson",
  )(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const connection: ZcodeRpcConnection = yield* makeZcodeRpcConnection({
        binaryPath: zcodeSettings.binaryPath,
        cwd,
        env: providerEnv,
        platform,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const requestedModel = resolveZcodeModelSlug(modelSelection.model);
      // Ephemeral background sessions must never touch the workspace: plan
      // mode keeps the model from running tools while it answers.
      const created = yield* zcodeCreateSession(connection, {
        cwd,
        mode: "plan",
        ...(requestedModel ? { modelId: requestedModel } : {}),
        ...(apiKey ? { providerId: ZCODE_API_TEMPLATE_PROVIDER_ID } : {}),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to start the ephemeral ZCode session.",
              cause,
            }),
        ),
      );
      yield* connection
        .request("session/send", { sessionId: created.sessionId, content: prompt })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to send the ZCode text-generation prompt.",
                cause,
              }),
          ),
        );
      const settled = yield* drainUntilTerminal(connection).pipe(
        Effect.catch((cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "ZCode text generation ended without a terminal event.",
              cause,
            }),
          ),
        ),
      );
      if (settled.terminalFailure !== undefined) {
        return yield* new TextGenerationError({
          operation,
          detail: settled.terminalFailure,
        });
      }
      if (!settled.output.trim()) {
        return yield* new TextGenerationError({
          operation,
          detail: "ZCode returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "ZCode", settled.output);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.timeoutOption(ZCODE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "ZCode request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
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
    },
  );

  return TextGenerationOperations.fromRunner(
    "ZcodeTextGeneration",
    TextGenerationOperations.withoutInvestigation("ZCode", runZcodeJson),
  );
});
