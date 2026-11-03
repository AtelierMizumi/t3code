export type AutoOrchestratorTier = 1 | 2 | 3;

/** Gemini effort suffix used in Antigravity model slugs (`gemini-3.8-flash-<effort>`). */
export type GeminiEffort = "low" | "medium" | "high";

export interface IntentClassificationResult {
  readonly tier: AutoOrchestratorTier;
  readonly triggeredSkill?: string;
  readonly reason: string;
  readonly overrideTag?: string;
  readonly effort?: GeminiEffort;
  readonly asksAdvisor?: boolean;
}

const TAG_REGEX = /@(claude|gemini)\b/gi;

const ADVISOR_NATURAL_REGEX =
  /\b(nhờ claude|hỏi claude|tham vấn|cố vấn|advisor|second opinion|phản biện|chất vấn|cross-check|ask claude|consult claude)\b/i;

const HIGH_RISK_AUDIT_REGEX =
  /\b(race condition|concurrency|deadlock|thread-safe|thread safe|lỗ hổng bảo mật|security audit|audit security|vulnerability audit)\b/i;

export function stripRoutingTags(prompt: string): string {
  return prompt
    .replace(TAG_REGEX, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function classifyPromptIntent(prompt: string): IntentClassificationResult {
  // 1. Tag Override Check
  if (/@claude\b/i.test(prompt)) {
    // @claude asks for advice, not a model switch, so the tier comes from the prompt itself.
    return {
      ...classifyPromptIntent(stripRoutingTags(prompt)),
      overrideTag: "@claude",
      asksAdvisor: true,
    };
  }
  if (/@gemini\b/i.test(prompt)) {
    return {
      tier: 2,
      reason: "Explicit @gemini override",
      overrideTag: "@gemini",
      effort: "medium",
      asksAdvisor: false,
    };
  }

  const asksAdvisor = ADVISOR_NATURAL_REGEX.test(prompt) || HIGH_RISK_AUDIT_REGEX.test(prompt);

  // 2. Tier 1: Architecture, Spec, Review, Security, Vulnerability, Grilling
  if (
    /\b(spec|architecture|kiến trúc|thiết kế|review|audit|vulnerability|security|chất vấn|grill)\b/i.test(
      prompt,
    )
  ) {
    const isGrilling = /\b(grill|chất vấn)\b/i.test(prompt);
    return {
      tier: 1,
      triggeredSkill: isGrilling ? "grilling" : "code-review",
      reason: "Architectural & Review Intent",
      asksAdvisor,
    };
  }

  // 3. Tier 3: Fast utility, regex, explanation, format, commit message, one-liners
  if (
    /\b(regex|format|explain this|giải thích|one-liner|commit message|tóm tắt log)\b/i.test(prompt)
  ) {
    return {
      tier: 3,
      reason: "Fast Utility Intent",
      effort: "low",
      asksAdvisor,
    };
  }

  // 4. Bug Reports -> Tier 2 with systematic-debugging
  if (/\b(bug|crash|exception|sửa lỗi|lỗi|broken|fail)\b/i.test(prompt)) {
    return {
      tier: 2,
      triggeredSkill: "systematic-debugging",
      reason: "Debugging Intent",
      effort: "high",
      asksAdvisor,
    };
  }

  // 5. Tier 2: Coding, Implementation, Refactor, Tests
  if (/\b(test|tdd|implement|refactor|viết code)\b/i.test(prompt)) {
    return {
      tier: 2,
      triggeredSkill: "test-driven-development",
      reason: "Coding & TDD Intent",
      effort: "high",
      asksAdvisor,
    };
  }

  // Default Tier: Workhorse Gemini 3.8
  return {
    tier: 2,
    reason: "Default Coding Workhorse",
    effort: "medium",
    asksAdvisor,
  };
}
