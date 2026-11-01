export type AutoOrchestratorTier = 1 | 2 | 3;

export interface IntentClassificationResult {
  readonly tier: AutoOrchestratorTier;
  readonly triggeredSkill?: string;
  readonly reason: string;
  readonly overrideTag?: string;
}

const TAG_REGEX = /@(claude|gemini|deepseek|zcode)\b/gi;

export function stripRoutingTags(prompt: string): string {
  return prompt
    .replace(TAG_REGEX, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function classifyPromptIntent(prompt: string): IntentClassificationResult {
  // 1. Tag Override Check
  if (/@claude\b/i.test(prompt)) {
    return { tier: 1, reason: "Explicit @claude override", overrideTag: "@claude" };
  }
  if (/@gemini\b/i.test(prompt)) {
    return { tier: 2, reason: "Explicit @gemini override", overrideTag: "@gemini" };
  }
  if (/@deepseek\b/i.test(prompt)) {
    return { tier: 3, reason: "Explicit @deepseek override", overrideTag: "@deepseek" };
  }
  if (/@zcode\b/i.test(prompt)) {
    return { tier: 2, reason: "Explicit @zcode override", overrideTag: "@zcode" };
  }

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
    };
  }

  // 3. Tier 3: Fast utility, regex, explanation, format, commit message, one-liners
  if (
    /\b(regex|format|explain this|giải thích|one-liner|commit message|tóm tắt log)\b/i.test(prompt)
  ) {
    return {
      tier: 3,
      reason: "Fast Utility Intent",
    };
  }

  // 4. Bug Reports -> Tier 2 with systematic-debugging
  if (/\b(bug|crash|exception|sửa lỗi|lỗi|broken|fail)\b/i.test(prompt)) {
    return {
      tier: 2,
      triggeredSkill: "systematic-debugging",
      reason: "Debugging Intent",
    };
  }

  // 5. Tier 2: Coding, Implementation, Refactor, Tests
  if (/\b(test|tdd|implement|refactor|viết code)\b/i.test(prompt)) {
    return {
      tier: 2,
      triggeredSkill: "test-driven-development",
      reason: "Coding & TDD Intent",
    };
  }

  // Default Tier: Workhorse Gemini 3.8
  return {
    tier: 2,
    reason: "Default Coding Workhorse",
  };
}
