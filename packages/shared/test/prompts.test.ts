import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../src/env.ts";
import { buildPrompt, createPromptLoader, PromptError } from "../src/llm/prompts.ts";

const RAW = `---
model: claude-sonnet-5-5
effort: low
max_tokens: 1000
---
Ти — асистент {{brand.name}}.

=== user ===
Дані: {{data}}
`;

describe("prompts", () => {
  it("parses frontmatter, splits system/user, substitutes vars", () => {
    const p = buildPrompt("t", RAW, { brand: { name: "Зерно" }, data: { a: 1 } });
    expect(p).toMatchObject({ model: "claude-sonnet-5-5", effort: "low", maxTokens: 1000, cache: true });
    expect(p.system).toBe("Ти — асистент Зерно.");
    expect(p.user).toBe('Дані: {\n  "a": 1\n}');
    expect(p.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hash depends on the file, not on vars; CRLF-insensitive", () => {
    const a = buildPrompt("t", RAW, { brand: { name: "A" }, data: "x" });
    const b = buildPrompt("t", RAW.replaceAll("\n", "\r\n"), { brand: { name: "B" }, data: "y" });
    expect(a.hash).toBe(b.hash);
  });

  it("missing var and bad frontmatter throw", () => {
    expect(() => buildPrompt("t", RAW, { data: 1 })).toThrow(PromptError);
    expect(() => buildPrompt("t", "no frontmatter")).toThrow(PromptError);
    expect(() => buildPrompt("t", "---\nmodel: x\neffort: huge\nmax_tokens: 1\n---\n")).toThrow(PromptError);
  });

  it("loader reads from dir, rejects path traversal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "adc-prompts-"));
    writeFileSync(path.join(dir, "hello.md"), RAW);
    const loader = createPromptLoader({ dir });
    expect(loader.load("hello", { brand: { name: "X" }, data: "d" }).system).toContain("X");
    expect(() => loader.load("../secret")).toThrow(PromptError);
    expect(() => loader.load("missing")).toThrow(PromptError);
  });

  it("all repo prompts have valid frontmatter", () => {
    const dir = path.join(findRepoRoot(), "prompts");
    const loader = createPromptLoader({ dir });
    const names = [
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3)),
      ...readdirSync(path.join(dir, "elevenlabs")).map((f) => `elevenlabs/${f.slice(0, -3)}`),
    ];
    expect(names.sort()).toEqual(
      [
        "audio-plan",
        "brandkit",
        "brandkit-patch",
        "chat-intent",
        "chat-reply",
        "code-fix",
        "codegen",
        "elevenlabs/sfx-cues",
        "qa",
        "revise",
        "storyboard",
      ].sort(),
    );
    for (const n of names) expect(() => loader.load(n)).not.toThrow();
  });
});
