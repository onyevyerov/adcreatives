import { describe, expect, it } from "vitest";
import { fixtureBrandKit, fixtureStoryboard } from "../src/fixtures.ts";
import { allowedScreenTexts } from "../src/screen-texts.ts";

describe("allowedScreenTexts", () => {
  it("headline, sub, items[].text і CTA бренду — у цьому порядку", () => {
    const s2 = fixtureStoryboard.scenes[1];
    if (!s2) throw new Error("fixture");
    expect(allowedScreenTexts(s2, fixtureBrandKit)).toEqual([
      "Капучино — 75 грн",
      "-10% на каву з собою до 10:00",
      "Спешелті еспресо з молоком",
      "75 грн",
      "-10%",
      "Забронюйте столик",
    ]);
  });

  it("sub = null і порожні тексти пропускаються, дублікати зливаються", () => {
    const s1 = fixtureStoryboard.scenes[0];
    if (!s1) throw new Error("fixture");
    expect(allowedScreenTexts(s1, fixtureBrandKit)).toEqual([
      "Кава, яку обсмажуємо самі",
      "Забронюйте столик",
    ]);
    // CTA-сцена повторює CTA у headline — рядок один
    const s3 = fixtureStoryboard.scenes[2];
    if (!s3) throw new Error("fixture");
    expect(allowedScreenTexts(s3, fixtureBrandKit)).toEqual(["Забронюйте столик", "Львів, вул. Руська, 1"]);
    expect(allowedScreenTexts(s1, { cta: { text: " ", target: null } })).toEqual([
      "Кава, яку обсмажуємо самі",
    ]);
  });
});
