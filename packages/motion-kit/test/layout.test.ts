import { describe, expect, it } from "vitest";
import {
  approxMeasurer,
  fitSingleLine,
  fitText,
  type Measurer,
  markEmphasis,
  normalizeWord,
  splitWords,
  wrapWords,
} from "../src/text/layout.ts";

// Моноширинний вимірювач: кожен символ = 0.5 em — легко рахувати вручну.
const mono: Measurer = (text, fontSize) => text.length * fontSize * 0.5;

describe("wrapWords", () => {
  it("переносить жадібно по ширині", () => {
    // fontSize 10 → символ 5 px; "aaaa bbbb" = 45 px
    expect(wrapWords(["aaaa", "bbbb", "cc"], 50, 10, mono)).toEqual([["aaaa", "bbbb"], ["cc"]]);
    expect(wrapWords(["aaaa", "bbbb", "cc"], 40, 10, mono)).toEqual([["aaaa"], ["bbbb", "cc"]]);
  });

  it("слово, ширше за рядок, займає рядок саме", () => {
    expect(wrapWords(["a", "ccccccccccccc", "b"], 30, 10, mono)).toEqual([["a"], ["ccccccccccccc"], ["b"]]);
  });
});

describe("fitText", () => {
  it("лишає maxFontSize, якщо текст влазить", () => {
    const r = fitText({
      text: "Кава",
      maxLines: 2,
      width: 1000,
      maxFontSize: 120,
      minFontSize: 40,
      measure: mono,
    });
    expect(r).toMatchObject({ fontSize: 120, hitMin: false, overflow: false, lines: [["Кава"]] });
  });

  it("зменшує шрифт до найбільшого, з яким влазить у maxLines", () => {
    const text = "Кава яку обсмажуємо самі";
    const r = fitText({ text, maxLines: 2, width: 600, maxFontSize: 200, minFontSize: 20, measure: mono });
    expect(r.overflow).toBe(false);
    expect(r.hitMin).toBe(false);
    expect(r.lines.length).toBeLessThanOrEqual(2);
    expect(r.fontSize).toBeLessThan(200);
    // На 1 px більше вже не влазить.
    const bigger = fitText({
      text,
      maxLines: 2,
      width: 600,
      maxFontSize: r.fontSize + 1,
      minFontSize: r.fontSize + 1,
      measure: mono,
    });
    expect(bigger.overflow || bigger.lines.length > 2).toBe(true);
  });

  it("досягнутий мінімум → hitMin без overflow", () => {
    // 20 символів * 0.5 em: при 50 px ширина 500 → ширина 500 / 0.97 вміщає рівно на 50 px.
    const r = fitText({
      text: "aaaaaaaaaaaaaaaaaaaa",
      maxLines: 1,
      width: 516,
      maxFontSize: 100,
      minFontSize: 50,
      measure: mono,
    });
    expect(r).toMatchObject({ fontSize: 50, hitMin: true, overflow: false });
  });

  it("не влазить навіть на мінімумі → overflow, розмір = minFontSize", () => {
    const r = fitText({
      text: "Найдовший заголовок, який точно не влізе в один рядок",
      maxLines: 1,
      width: 840,
      maxFontSize: 120,
      minFontSize: 90,
      measure: approxMeasurer,
    });
    expect(r.overflow).toBe(true);
    expect(r.hitMin).toBe(true);
    expect(r.fontSize).toBe(90);
    expect(r.idealFontSize).toBeLessThan(90);
  });

  it("порожній текст не ламається", () => {
    expect(
      fitText({ text: "  ", maxLines: 2, width: 100, maxFontSize: 50, minFontSize: 10, measure: mono }),
    ).toMatchObject({
      lines: [],
      overflow: false,
    });
  });
});

describe("fitSingleLine", () => {
  // mono: символ 0.5 em; CTA l: номінал 56, мінімум 34 (60%), padding 2.8 em.
  const cta = { maxFontSize: 56, minFontSize: 34, paddingEm: 2.8, measure: mono };

  it("короткий текст лишається на номіналі", () => {
    // "-30%" = 2 em + 2.8 em = 4.8 em → 269 px на 56 px.
    expect(fitSingleLine({ ...cta, text: "-30%", width: 960 })).toEqual({
      fontSize: 56,
      shrunk: false,
      overflow: false,
    });
  });

  it("стискає до найбільшого цілого кегля, з яким бокс влазить", () => {
    // 24 символи = 12 em + 2.8 em = 14.8 em; 960 / 14.8 = 64.9 → номінал 56 влазить.
    // 32 символи = 16 em + 2.8 em = 18.8 em; 960 / 18.8 = 51.06 → 51.
    const r = fitSingleLine({ ...cta, text: "a".repeat(32), width: 960 });
    expect(r).toEqual({ fontSize: 51, shrunk: true, overflow: false });
    expect(mono("a".repeat(32), r.fontSize) + 2.8 * r.fontSize).toBeLessThanOrEqual(960);
  });

  it("не влазить навіть на мінімумі → overflow, кегль = мінімум", () => {
    // 60 символів = 32.8 em; 960 / 32.8 = 29.3 < 34.
    expect(fitSingleLine({ ...cta, text: "a".repeat(60), width: 960 })).toEqual({
      fontSize: 34,
      shrunk: true,
      overflow: true,
    });
  });

  it("вужча ширина (maxWidth) стискає той самий текст", () => {
    // 16 символів = 10.8 em: у 960 px — номінал, у 420 px — 420 / 10.8 = 38.9 → 38.
    const text = "a".repeat(16);
    expect(fitSingleLine({ ...cta, text, width: 960 }).fontSize).toBe(56);
    expect(fitSingleLine({ ...cta, text, width: 420 })).toEqual({
      fontSize: 38,
      shrunk: true,
      overflow: false,
    });
  });
});

describe("emphasis", () => {
  it("нормалізує регістр і пунктуацію по краях, зберігає % і мінус", () => {
    expect(normalizeWord("Самі!")).toBe("самі");
    expect(normalizeWord("«Зерно»,")).toBe("зерно");
    expect(normalizeWord("-10%")).toBe("-10%");
    expect(normalizeWord("грн.")).toBe("грн");
  });

  it("позначає фрази з кількох слів, пропускаючи тире", () => {
    const words = splitWords("Капучино — 75 грн");
    expect(markEmphasis(words, ["75 грн"])).toEqual([false, false, true, true]);
    expect(markEmphasis(words, ["Капучино — 75 грн"])).toEqual([true, false, true, true]);
    expect(markEmphasis(words, ["капучино"])).toEqual([true, false, false, false]);
    expect(markEmphasis(words, [])).toEqual([false, false, false, false]);
  });
});
