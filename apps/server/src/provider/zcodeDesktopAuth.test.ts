// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  hasZcodeProviderCredential,
  readZcodeDesktopPlan,
  type ZcodeDesktopPlan,
} from "./zcodeDesktopAuth.ts";

function readPlanFromFixture(config: unknown, credentials: unknown): ZcodeDesktopPlan | null {
  const storage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-auth-"));
  const v2 = NodePath.join(storage, "v2");
  NodeFS.mkdirSync(v2);
  NodeFS.writeFileSync(NodePath.join(v2, "config.json"), JSON.stringify(config));
  NodeFS.writeFileSync(NodePath.join(v2, "credentials.json"), JSON.stringify(credentials));
  try {
    return readZcodeDesktopPlan({ ZCODE_STORAGE_DIR: storage });
  } finally {
    NodeFS.rmSync(storage, { recursive: true, force: true });
  }
}

describe("readZcodeDesktopPlan", () => {
  it("keeps the first enabled preferred provider instead of falling through to a custom one", () => {
    const plan = readPlanFromFixture(
      {
        provider: {
          "builtin:zai": { models: { "GLM-5.3": {} } },
          "custom:other": { models: { "other-model": {} } },
        },
      },
      { "oauth:builtin:zai": { token: "redacted" } },
    );

    expect(plan).toMatchObject({
      providerId: "builtin:zai",
      modelId: "GLM-5.3",
      authenticated: true,
    });
  });

  it("does not treat an unrelated provider token as Z.AI authentication", () => {
    const plan = readPlanFromFixture(
      {
        provider: {
          "builtin:zai-coding-plan": { models: { "GLM-5.3": {} } },
        },
      },
      { "oauth:custom:other": { token: "redacted" } },
    );

    expect(plan?.authenticated).toBe(false);
  });
});

describe("hasZcodeProviderCredential", () => {
  it("matches provider-scoped OAuth credentials", () => {
    expect(
      hasZcodeProviderCredential(
        { "oauth:builtin:zai-coding-plan": { token: "redacted" } },
        "builtin:zai-coding-plan",
      ),
    ).toBe(true);
  });

  it("only accepts the legacy ZCode JWT for Z.AI providers", () => {
    expect(hasZcodeProviderCredential({ zcodejwttoken: "redacted" }, "builtin:zai")).toBe(true);
    expect(hasZcodeProviderCredential({ zcodejwttoken: "redacted" }, "custom:other")).toBe(false);
  });
});
