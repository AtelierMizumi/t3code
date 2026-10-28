/**
 * Read the ZCode desktop app's coding-plan selection so T3 sessions use the
 * same Z.AI quota as the app, not a third-party API-key client like Pi.
 *
 * @module provider/zcodeDesktopAuth
 */
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

const DEFAULT_MODEL_ID = "GLM-5.3";
const PREFERRED_PROVIDER_IDS = [
  "builtin:zai-coding-plan",
  "builtin:zai",
  "builtin:bigmodel-coding-plan",
] as const;

export interface ZcodeDesktopPlan {
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl: string | undefined;
  readonly modelIds: ReadonlyArray<string>;
  readonly authenticated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(NodeFs.readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function zcodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const storage = env.ZCODE_STORAGE_DIR?.trim();
  if (storage) return storage;
  return NodePath.join(NodeOs.homedir(), ".zcode");
}

function modelIdsFromProvider(provider: Record<string, unknown>): string[] {
  const models = provider.models;
  if (!isRecord(models)) return [];
  return Object.keys(models).filter((key) => key.trim().length > 0);
}

function pickPreferredModel(modelIds: ReadonlyArray<string>): string {
  if (modelIds.includes(DEFAULT_MODEL_ID)) return DEFAULT_MODEL_ID;
  return modelIds[0] ?? DEFAULT_MODEL_ID;
}

function providerEnabled(provider: Record<string, unknown>): boolean {
  return provider.enabled !== false;
}

export function readZcodeDesktopPlan(
  env: NodeJS.ProcessEnv = process.env,
): ZcodeDesktopPlan | null {
  const home = zcodeHome(env);
  const config = readJsonFile(NodePath.join(home, "v2", "config.json"));
  if (!isRecord(config) || !isRecord(config.provider)) {
    return null;
  }

  const providers = config.provider;
  const orderedIds = [
    ...PREFERRED_PROVIDER_IDS.filter((id) => id in providers),
    ...Object.keys(providers).filter(
      (id) => !(PREFERRED_PROVIDER_IDS as ReadonlyArray<string>).includes(id),
    ),
  ];

  let selected: { readonly id: string; readonly provider: Record<string, unknown> } | undefined;
  for (const id of orderedIds) {
    const provider = providers[id];
    if (!isRecord(provider) || !providerEnabled(provider)) continue;
    selected = { id, provider };
    if (id.startsWith("builtin:") && id.includes("coding-plan")) {
      break;
    }
  }
  if (!selected) return null;

  const options = isRecord(selected.provider.options) ? selected.provider.options : {};
  const baseUrl = typeof options.baseURL === "string" ? options.baseURL.trim() : "";
  const modelIds = modelIdsFromProvider(selected.provider);
  const credentials = readJsonFile(NodePath.join(home, "v2", "credentials.json"));
  const authenticated = isRecord(credentials)
    ? Object.keys(credentials).some(
        (key) =>
          key.startsWith("oauth:") ||
          key === "zcodejwttoken" ||
          key.toLowerCase().includes("token"),
      )
    : false;

  return {
    providerId: selected.id,
    modelId: pickPreferredModel(modelIds),
    baseUrl: baseUrl.length > 0 ? baseUrl : undefined,
    modelIds: modelIds.length > 0 ? modelIds : [DEFAULT_MODEL_ID],
    authenticated,
  };
}

export function zcodeModelEnvValue(plan: ZcodeDesktopPlan): string {
  return `${plan.providerId}/${plan.modelId}`;
}

export function buildZcodeDesktopSpawnEnv(
  environment: NodeJS.ProcessEnv,
  plan: ZcodeDesktopPlan | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...environment,
    ZCODE_TELEMETRY_RUNTIME_SURFACE: "desktop",
    ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "desktop",
  };
  if (plan) {
    env.ZCODE_MODEL = zcodeModelEnvValue(plan);
    if (plan.baseUrl) {
      env.ZCODE_BASE_URL = plan.baseUrl;
    }
  }
  return env;
}
