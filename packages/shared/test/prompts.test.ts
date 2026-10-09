import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../src/env.ts";
import { buildPrompt, createPromptLoader, PromptError, parsePromptFile } from "../src/llm/prompts.ts";

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
        "motion-reference",
        "qa",
        "revise",
        "storyboard",
        "storyboard-copyfix",
      ].sort(),
    );
    // Лише frontmatter: наповнені промпти мають {{змінні}}, які передає стадія.
    for (const n of names) {
      expect(() => parsePromptFile(readFileSync(path.join(dir, `${n}.md`), "utf8"), n)).not.toThrow();
    }
  });

  describe("Крок 0: prefix, cache_ttl, === cache ===, schema_mode", () => {
    const REF = `---
kind: prefix
cache_ttl: 1h
---
Довідка для {{brand.name}}.
`;
    const STAGE = (ttl: string, extra = "") => `---
model: claude-opus-5-5
effort: high
max_tokens: 1000
prefix: ref
cache_ttl: ${ttl}
${extra}---
Правила стадії.

=== user ===
Бренд: {{brand.name}}
=== cache ===
Сцена: {{scene}}
`;
    const loaderWith = (files: Record<string, string>) => {
      const dir = mkdtempSync(path.join(tmpdir(), "adc-prompts-"));
      for (const [n, raw] of Object.entries(files)) writeFileSync(path.join(dir, `${n}.md`), raw);
      return createPromptLoader({ dir });
    };

    it("prefix рендериться з тими самими vars; хвіст після === cache ===; дефолти", () => {
      const loader = loaderWith({ ref: REF, stage: STAGE("1h") });
      const p = loader.load("stage", { brand: { name: "Зерно" }, scene: "s1" });
      expect(p.prefix).toEqual({
        name: "ref",
        system: "Довідка для Зерно.",
        cacheTtl: "1h",
        hash: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(p.system).toBe("Правила стадії.");
      expect(p.userCached).toBe("Бренд: Зерно");
      expect(p.user).toBe("Сцена: s1");
      expect(p.cacheTtl).toBe("1h");
      expect(p.schemaMode).toBe("grammar");

      const plain = buildPrompt("t", RAW, { brand: { name: "X" }, data: 1 });
      expect(plain).toMatchObject({ prefix: null, userCached: null, cacheTtl: "5m", schemaMode: "grammar" });
    });

    it("hash = власний файл + файл prefix", () => {
      const a = loaderWith({ ref: REF, stage: STAGE("1h") }).load("stage", {
        brand: { name: "A" },
        scene: 1,
      });
      const b = loaderWith({ ref: `${REF}Ще рядок.\n`, stage: STAGE("1h") }).load("stage", {
        brand: { name: "A" },
        scene: 1,
      });
      expect(a.hash).not.toBe(b.hash);
      expect(a.prefix?.hash).not.toBe(b.prefix?.hash);
    });

    it("TTL не зростають: stage 1h після prefix 5m — PromptError", () => {
      const loader = loaderWith({ ref: REF.replace("1h", "5m"), stage: STAGE("1h") });
      expect(() => loader.load("stage", { brand: { name: "A" }, scene: 1 })).toThrow(/cache_ttl/);
      // stage 5m після prefix 1h — дозволено.
      const ok = loaderWith({ ref: REF, stage: STAGE("5m") }).load("stage", {
        brand: { name: "A" },
        scene: 1,
      });
      expect(ok.cacheTtl).toBe("5m");
    });

    it("kind: prefix не викликається напряму і не має user-частини; prefix без prefix", () => {
      const loader = loaderWith({
        ref: REF,
        "with-user": `${REF}\n=== user ===\nx`,
        nested: REF.replace("cache_ttl: 1h", "cache_ttl: 1h\nprefix: ref"),
        stage: STAGE("1h").replace("prefix: ref", "prefix: with-user"),
      });
      expect(() => loader.load("ref", { brand: { name: "A" } })).toThrow(PromptError);
      expect(() => loader.load("stage", { brand: { name: "A" }, scene: 1 })).toThrow(/user-частини/);
      expect(() => parsePromptFile(REF.replace("cache_ttl: 1h", "cache_ttl: 1h\nprefix: ref"))).toThrow(
        PromptError,
      );
      // prefix, що вказує на звичайний промпт, — помилка.
      const wrong = loaderWith({ plain: RAW, stage: STAGE("5m").replace("prefix: ref", "prefix: plain") });
      expect(() => wrong.load("stage", { brand: { name: "A" }, scene: 1, data: 1 })).toThrow(/kind: prefix/);
    });

    it("kind: call вимагає model/effort/max_tokens; schema_mode і cache_ttl валідуються", () => {
      expect(() => parsePromptFile("---\neffort: low\nmax_tokens: 1\n---\nx")).toThrow(PromptError);
      expect(() =>
        parsePromptFile(RAW.replace("max_tokens: 1000", "max_tokens: 1000\ncache_ttl: 2h")),
      ).toThrow(PromptError);
      expect(
        parsePromptFile(RAW.replace("max_tokens: 1000", "max_tokens: 1000\nschema_mode: prompt")).meta,
      ).toMatchObject({ schema_mode: "prompt", kind: "call" });
    });

    it("=== cache ===: лише в user-частині й не більше одного", () => {
      const twice = RAW.replace("Дані: {{data}}", "a\n=== cache ===\nb\n=== cache ===\nc");
      expect(() => buildPrompt("t", twice, { brand: { name: "X" }, data: 1 })).toThrow(PromptError);
      const inSystem = RAW.replace("Ти — асистент", "=== cache ===\nТи — асистент");
      expect(() => buildPrompt("t", inSystem, { brand: { name: "X" }, data: 1 })).toThrow(PromptError);
    });

    it("репозиторій: codegen і code-fix мають спільний prefix motion-reference (1h), brandkit — schema_mode: prompt", () => {
      const loader = createPromptLoader();
      const vars = {
        remotionSystemPrompt: "REMOTION",
        motionKitApi: "API",
        motionKitDeclarations: "DECL",
        examples: "EXAMPLES",
      };
      const codegen = loader.load("codegen", {
        ...vars,
        mode: "anchor",
        targets: "s1",
        language: "uk",
        formats: "vertical",
        brand: {},
        storyboard: {},
        assets: [],
        instructions: "-",
        readonlyScenes: "-",
      });
      const fix = loader.load("code-fix", {
        ...vars,
        brand: {},
        assets: [],
        concept: "-",
        scene: {},
        code: "-",
        problems: "-",
        language: "uk",
        formats: "vertical",
        reason: "check",
        sceneId: "s1",
      });
      for (const p of [codegen, fix]) {
        expect(p.prefix?.name).toBe("motion-reference");
        expect(p.prefix?.cacheTtl).toBe("1h");
        expect(p.cacheTtl).toBe("1h");
        expect(p.system).not.toContain("REMOTION");
        expect(p.system).not.toContain("<remotion_reference>");
      }
      // Байт-ідентичний prefix — один запис кешу на обидві стадії.
      expect(fix.prefix?.system).toBe(codegen.prefix?.system);
      const ref = codegen.prefix?.system ?? "";
      for (const part of ["REMOTION", "API", "DECL", "EXAMPLES", "Remotion reference is general"]) {
        expect(ref).toContain(part);
      }
      expect(fix.user).not.toContain("у всіх трьох");
      expect(
        parsePromptFile(readFileSync(path.join(findRepoRoot(), "prompts", "brandkit.md"), "utf8")).meta
          .schema_mode,
      ).toBe("prompt");
    });
  });
});
