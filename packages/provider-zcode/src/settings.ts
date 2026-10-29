// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  secretSetting,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ZcodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      // Off by default: probe the installed ZCode app/CLI only when opted in.
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("zcode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Path to the ZCode CLI (`zcode.cjs` from the desktop app). Leave blank to auto-discover the app bundle.",
        providerSettingsForm: { placeholder: "zcode", clearWhenEmpty: "omit" },
      }),
    ),
    apiKey: secretSetting(TrimmedString).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Coding plan API key",
        description:
          "Z.AI coding-plan API key. Creates the zai-api provider (GLM-5.3, GLM-5.3 Flash) inside ZCode's own provider stack; billed to your coding plan.",
        providerSettingsForm: { control: "password", placeholder: "", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiKey"],
  },
);
export type ZcodeSettings = typeof ZcodeSettings.Type;
