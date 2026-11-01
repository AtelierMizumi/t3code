import { describe, expect, it } from "vite-plus/test";
import { classifyPromptIntent, stripRoutingTags } from "./intentMatcher.ts";

describe("classifyPromptIntent", () => {
  it("tags @claude without forcing tier 1; sets asksAdvisor to true", () => {
    const result = classifyPromptIntent("@claude hãy viết regex kiểm tra email");
    expect(result.tier).toBe(3);
    expect(result.overrideTag).toBe("@claude");
    expect(result.asksAdvisor).toBe(true);
    expect(classifyPromptIntent("@claude review kiến trúc").tier).toBe(1);
    expect(classifyPromptIntent("@claude review kiến trúc").asksAdvisor).toBe(true);
  });

  it("prioritizes explicit @gemini tag override", () => {
    const result = classifyPromptIntent("@gemini hãy review kiến trúc hệ thống");
    expect(result.tier).toBe(2);
    expect(result.overrideTag).toBe("@gemini");
  });

  it("does not treat @deepseek or @zcode as routing tags", () => {
    expect(classifyPromptIntent("@deepseek viết regex email").overrideTag).toBeUndefined();
    expect(classifyPromptIntent("@zcode giải quyết thuật toán").overrideTag).toBeUndefined();
  });

  it("detects natural language advisor intent without needing @ tags", () => {
    expect(classifyPromptIntent("nhờ claude xem giúp tôi đoạn logic này").asksAdvisor).toBe(true);
    expect(
      classifyPromptIntent("cho tôi second opinion về race condition ở queue này").asksAdvisor,
    ).toBe(true);
    expect(classifyPromptIntent("cần tham vấn cố vấn về mô hình dữ liệu").asksAdvisor).toBe(true);
    expect(classifyPromptIntent("phản biện giúp tôi thiết kế hệ thống này").asksAdvisor).toBe(true);
    expect(
      classifyPromptIntent("ask claude for a second opinion on this architecture").asksAdvisor,
    ).toBe(true);
  });

  it("detects high-risk concurrency and security audit as asksAdvisor", () => {
    expect(classifyPromptIntent("kiểm tra race condition trong worker pool").asksAdvisor).toBe(
      true,
    );
    expect(
      classifyPromptIntent("is this thread-safe or does it have a deadlock?").asksAdvisor,
    ).toBe(true);
    expect(
      classifyPromptIntent("security audit và kiểm tra lỗ hổng bảo mật module auth").asksAdvisor,
    ).toBe(true);
  });

  it("does not flag routine coding or fast utility as asksAdvisor", () => {
    expect(classifyPromptIntent("viết hàm tính tổng hai số").asksAdvisor).toBe(false);
    expect(classifyPromptIntent("format lại file json này").asksAdvisor).toBe(false);
    expect(classifyPromptIntent("fix this bug: null pointer exception").asksAdvisor).toBe(false);
  });

  it("classifies architectural and review prompts as Tier 1 with code-review skill", () => {
    const r1 = classifyPromptIntent("Hãy thiết kế kiến trúc Clean Architecture cho module auth");
    expect(r1.tier).toBe(1);
    expect(r1.triggeredSkill).toBe("code-review");

    const r2 = classifyPromptIntent("Review PR diff and audit security vulnerabilities");
    expect(r2.tier).toBe(1);
    expect(r2.triggeredSkill).toBe("code-review");
  });

  it("classifies fast utility and regex prompts as Tier 3", () => {
    const r1 = classifyPromptIntent("Viết regex kiểm tra định dạng số điện thoại Việt Nam");
    expect(r1.tier).toBe(3);

    const r2 = classifyPromptIntent("Giải thích dòng code này giúp tôi");
    expect(r2.tier).toBe(3);

    const r3 = classifyPromptIntent("Format and generate conventional commit message");
    expect(r3.tier).toBe(3);
  });

  it("classifies bug reports as Tier 2 with systematic-debugging skill", () => {
    const result = classifyPromptIntent("Fix this bug: server crash with unhandled exception");
    expect(result.tier).toBe(2);
    expect(result.triggeredSkill).toBe("systematic-debugging");
  });

  it("classifies general coding and implementation prompts as Tier 2 with TDD skill", () => {
    const result = classifyPromptIntent("Implement feature user profile editing with tests");
    expect(result.tier).toBe(2);
    expect(result.triggeredSkill).toBe("test-driven-development");
  });

  it("falls back to Tier 2 for general/unspecified queries", () => {
    const result = classifyPromptIntent("Xin chào, hôm nay thế nào?");
    expect(result.tier).toBe(2);
  });
});

describe("classifyPromptIntent effort", () => {
  it("maps debugging and TDD prompts to high effort", () => {
    expect(classifyPromptIntent("Fix this bug: server crash").effort).toBe("high");
    expect(classifyPromptIntent("Implement feature with tests").effort).toBe("high");
  });

  it("maps default coding prompts to medium effort", () => {
    expect(classifyPromptIntent("Xin chào, hôm nay thế nào?").effort).toBe("medium");
  });

  it("maps fast utility prompts to low effort", () => {
    expect(classifyPromptIntent("Viết regex kiểm tra email").effort).toBe("low");
  });
});

describe("stripRoutingTags", () => {
  it("strips tag from beginning of prompt and trims whitespace", () => {
    expect(stripRoutingTags("@claude Hãy viết spec")).toBe("Hãy viết spec");
    expect(stripRoutingTags("@gemini    code tính năng này")).toBe("code tính năng này");
    expect(stripRoutingTags("@deepseek regex email")).toBe("@deepseek regex email");
  });

  it("strips tag inside prompt", () => {
    expect(stripRoutingTags("Hãy dùng @claude để review")).toBe("Hãy dùng để review");
  });

  it("leaves prompt untouched if no tag exists", () => {
    expect(stripRoutingTags("Không có tag nào")).toBe("Không có tag nào");
  });
});
