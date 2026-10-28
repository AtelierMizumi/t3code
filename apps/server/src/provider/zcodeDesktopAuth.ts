// @effect-diagnostics nodeBuiltinImport:off - ZCode owns this synchronous desktop config boundary.
/**
 * Read the ZCode desktop app's coding-plan selection so T3 sessions use the
 * same Z.AI quota as the app, not a third-party API-key client like Pi.
 *
 * @module provider/zcodeDesktopAuth
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Predicate from "effect/Predicate";

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

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function zcodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const storage = env.ZCODE_STORAGE_DIR?.trim();
  if (storage) return storage;
  return NodePath.join(NodeOS.homedir(), ".zcode");
}

function modelIdsFromProvider(provider: Record<string, unknown>): string[] {
  const models = provider.models;
  if (!Predicate.isObject(models)) return [];
  return Object.keys(models).filter((key) => key.trim().length > 0);
}

function pickPreferredModel(modelIds: ReadonlyArray<string>): string {
  if (modelIds.includes(DEFAULT_MODEL_ID)) return DEFAULT_MODEL_ID;
  return modelIds[0] ?? DEFAULT_MODEL_ID;
}

function providerEnabled(provider: Record<string, unknown>): boolean {
  return provider.enabled !== false;
}

function credentialKeyMatchesProvider(key: string, providerId: string): boolean {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedProviderId = providerId.trim().toLowerCase();
  const withoutBuiltinPrefix = normalizedProviderId.replace(/^builtin:/, "");
  const aliases = new Set([normalizedProviderId, withoutBuiltinPrefix]);

  if (withoutBuiltinPrefix.startsWith("zai")) aliases.add("zai");
  if (withoutBuiltinPrefix.startsWith("bigmodel")) aliases.add("bigmodel");

  if (normalizedKey === "zcodejwttoken") {
    return withoutBuiltinPrefix.startsWith("zai");
  }

  return [...aliases].some(
    (alias) =>
      normalizedKey === alias ||
      normalizedKey === `oauth:${alias}` ||
      normalizedKey.startsWith(`oauth:${alias}:`) ||
      normalizedKey === `token:${alias}` ||
      normalizedKey.startsWith(`token:${alias}:`) ||
      normalizedKey === `${alias}:token`,
  );
}

export function hasZcodeProviderCredential(credentials: unknown, providerId: string): boolean {
  return (
    Predicate.isObject(credentials) &&
    Object.keys(credentials).some((key) => credentialKeyMatchesProvider(key, providerId))
  );
}

export function readZcodeDesktopPlan(
  env: NodeJS.ProcessEnv = process.env,
): ZcodeDesktopPlan | null {
  const home = zcodeHome(env);
  const config = readJsonFile(NodePath.join(home, "v2", "config.json"));
  if (!Predicate.isObject(config) || !Predicate.isObject(config.provider)) {
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
    if (!Predicate.isObject(provider) || !providerEnabled(provider)) continue;
    selected = { id, provider };
    break;
  }
  if (!selected) return null;

  const options = Predicate.isObject(selected.provider.options) ? selected.provider.options : {};
  const baseUrl = typeof options.baseURL === "string" ? options.baseURL.trim() : "";
  const modelIds = modelIdsFromProvider(selected.provider);
  const credentials = readJsonFile(NodePath.join(home, "v2", "credentials.json"));
  const authenticated = hasZcodeProviderCredential(credentials, selected.id);

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
