import { emptySubstance, type ProductSubstance } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { SUBSTANCE_LIMITS, substanceMatcher, verifySubstance } from "../src/substance.ts";

/** Стиснений текст сайту, як у brandkit/site-text.txt (SaaS-аудит сайтів). */
const SITE_TEXT = [
  '<page url="https://audit.example.com/" title="Аудит сайту за 5 хвилин">',
  "# Аудит сайту за 5 хвилин",
  "Опис: AI-аудит сайту: SEO, швидкість, доступність.",
  "## Як це працює",
  "Вставте URL вашого сайту",
  "AI сканує сайт — 120 перевірок",
  "Отримуєте план робіт на тиждень",
  "## Що ми перевіряємо",
  "SEO | Швидкість | Доступність | Безпека",
  "## Приклад звіту",
  "Зображення без alt-тексту",
  "Критично · Оцінка 42/100",
  "Пошукові системи й скринрідери не бачать, що на картинці.",
  "Додайте опис до кожного зображення",
  "1 тиждень: Стиснути зображення на головній — 3 години",
  "Агенція: 3–10 робочих днів | Ми: 5 хвилин",
  "Кнопки: Перевірити сайт | Ціни",
  "‹script› у шапці блокує рендер",
  "› Немає мета-опису · 3 години",
  "</page>",
].join("\n");

function substance(over: Partial<ProductSubstance>): ProductSubstance {
  return { ...emptySubstance(), ...over };
}

describe("substanceMatcher", () => {
  const find = substanceMatcher(SITE_TEXT);

  it("finds a line ignoring case, spaces, quotes and dash variants; returns the site spelling", () => {
    expect(find("вставте url вашого сайту")).toBe("Вставте URL вашого сайту");
    expect(find("AI  сканує сайт - 120 перевірок")).toBe("AI сканує сайт — 120 перевірок");
    expect(find("Агенція: 3-10 робочих днів")).toBe("Агенція: 3–10 робочих днів");
    expect(find("«Зображення без alt-тексту».")).toBe("Зображення без alt-тексту");
    expect(find("<script> у шапці")).toBe("‹script› у шапці");
    // Маркер демо-рядка краулера («> », у site-text.txt — «› ») ігнорується.
    expect(find("> Немає мета-опису")).toBe("Немає мета-опису");
    expect(find("› Немає мета-опису")).toBe("Немає мета-опису");
    expect(find("Немає мета-опису")).toBe("Немає мета-опису");
  });

  it("matches by word boundaries and never invents", () => {
    expect(find("Швидкість")).toBe("Швидкість");
    expect(find("Швидк")).toBeNull();
    expect(find("5 хвилин")).toBe("5 хвилин");
    expect(find("15 хвилин")).toBeNull();
    expect(find("Аудит за 5 хвилин")).toBeNull();
    expect(find("   ")).toBeNull();
  });

  it("finds nothing without site text", () => {
    expect(substanceMatcher(null)("SEO")).toBeNull();
    expect(substanceMatcher("  ")("SEO")).toBeNull();
  });
});

describe("verifySubstance", () => {
  it("keeps verbatim lines and canonicalizes them to the site spelling", () => {
    const input = substance({
      steps: [
        { name: "Вставте URL вашого сайту", detail: null },
        { name: "AI сканує сайт", detail: "120 перевірок" },
        { name: "Отримуєте план робіт на тиждень", detail: "" },
      ],
      checks: ["SEO", "швидкість", "Доступність", "БЕЗПЕКА "],
      exampleIssues: [
        {
          title: "Зображення без alt-тексту",
          severity: "critical",
          score: "42/100",
          explanation: "Пошукові системи й скринрідери не бачать, що на картинці.",
          fix: "Додайте опис до кожного зображення",
          effort: "3 години",
        },
      ],
      planRows: [{ text: "Стиснути зображення на головній", group: "1 тиждень", effort: "3 години" }],
      products: [{ name: "AI-аудит сайту", oneLiner: "SEO, швидкість, доступність" }],
      comparisons: [{ criterion: "Агенція", us: "5 хвилин", alternative: "3-10 робочих днів" }],
    });
    const { substance: out, fixes } = verifySubstance(input, SITE_TEXT);
    expect(fixes).toEqual([]);
    expect(out.steps).toEqual([
      { name: "Вставте URL вашого сайту", detail: null },
      { name: "AI сканує сайт", detail: "120 перевірок" },
      { name: "Отримуєте план робіт на тиждень", detail: null },
    ]);
    // «швидкість» малими є в описі сторінки — написання моделі лишається; «БЕЗПЕКА» — як на сайті.
    expect(out.checks).toEqual(["SEO", "швидкість", "Доступність", "Безпека"]);
    expect(out.exampleIssues[0]).toMatchObject({ severity: "critical", score: "42/100", effort: "3 години" });
    expect(out.planRows).toEqual([
      { text: "Стиснути зображення на головній", group: "1 тиждень", effort: "3 години" },
    ]);
    expect(out.comparisons).toEqual([
      { criterion: "Агенція", us: "5 хвилин", alternative: "3–10 робочих днів" },
    ]);
  });

  it("drops records whose key line is not on the site and nulls invented details, reporting in fixes", () => {
    const input = substance({
      steps: [
        { name: "Вставте URL вашого сайту", detail: "за 10 секунд" },
        { name: "Підключіть Google Analytics", detail: null },
      ],
      checks: ["SEO", "Юзабіліті"],
      exampleIssues: [
        {
          title: "Зображення без alt-тексту",
          severity: "moderate",
          score: "17/100",
          explanation: null,
          fix: null,
          effort: null,
        },
        {
          title: "Повільний сервер",
          severity: "critical",
          score: null,
          explanation: null,
          fix: null,
          effort: null,
        },
      ],
      planRows: [{ text: "Переписати весь сайт", group: "1 тиждень", effort: null }],
      products: [{ name: "Аудит Pro", oneLiner: null }],
      comparisons: [{ criterion: "Агенція", us: "1 хвилина", alternative: "3–10 робочих днів" }],
    });
    const { substance: out, fixes } = verifySubstance(input, SITE_TEXT);
    expect(out.steps).toEqual([{ name: "Вставте URL вашого сайту", detail: null }]);
    expect(out.checks).toEqual(["SEO"]);
    expect(out.exampleIssues).toEqual([
      {
        title: "Зображення без alt-тексту",
        severity: "moderate",
        score: null,
        explanation: null,
        fix: null,
        effort: null,
      },
    ]);
    expect(out.planRows).toEqual([]);
    expect(out.products).toEqual([]);
    expect(out.comparisons).toEqual([]);

    const report = fixes.join("\n");
    for (const dropped of [
      "Підключіть Google Analytics",
      "Юзабіліті",
      "Повільний сервер",
      "Переписати весь сайт",
      "Аудит Pro",
      "1 хвилина",
      "за 10 секунд",
      "17/100",
    ]) {
      expect(report).toContain(dropped);
    }
    expect(report).toMatch(/Речовина продукту \(крок\)/);
  });

  it("drops everything when there is no site text", () => {
    const { substance: out, fixes } = verifySubstance(substance({ checks: ["SEO"] }), null);
    expect(out).toEqual(emptySubstance());
    expect(fixes).toHaveLength(1);
    expect(verifySubstance(emptySubstance(), null).fixes).toEqual([]);
  });

  it("removes duplicates and trims lists to the limits", () => {
    const checks = ["SEO", "seo", "Швидкість"];
    const many = Array.from({ length: SUBSTANCE_LIMITS.checks + 3 }, (_, i) => `Перевірка ${i + 1}`);
    const text = `${SITE_TEXT}\n${many.join("\n")}`;
    const { substance: out, fixes } = verifySubstance(substance({ checks: [...checks, ...many] }), text);
    expect(out.checks[0]).toBe("SEO");
    expect(out.checks[1]).toBe("Швидкість");
    expect(out.checks).toHaveLength(SUBSTANCE_LIMITS.checks);
    expect(fixes.join("\n")).toMatch(/лишено перші 12/);
  });

  it("is idempotent: a verified substance passes the check unchanged", () => {
    const input = substance({
      steps: [{ name: "вставте url вашого сайту", detail: null }],
      checks: ["seo"],
    });
    const once = verifySubstance(input, SITE_TEXT).substance;
    const twice = verifySubstance(once, SITE_TEXT);
    expect(twice.substance).toEqual(once);
    expect(twice.fixes).toEqual([]);
  });
});
