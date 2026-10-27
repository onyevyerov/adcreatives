import { fixtureBrandKit } from "@adc/shared/fixtures";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** Проп `by` у Headline і Body: "line" — елементи анімації по рядках, як у KineticText/TextBlock. */

const clock = { frame: 0 };
const config = { width: 1080, height: 1920, fps: 30, durationInFrames: 150 };
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return { ...actual, useCurrentFrame: () => clock.frame, useVideoConfig: () => config };
});
vi.mock("../src/qa.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/qa.tsx")>();
  return { ...actual, useQaCheck: () => {} };
});

const { ThemeProvider } = await import("../src/theme.tsx");
const { Body, Headline, KineticText } = await import("../src/text/components.tsx");

const TEXT = "Ремонт без стресу і з гарантією на кожен етап робіт";
// Вузький блок, щоб текст розбився на кілька рядків.
const WIDTH = 520;

function render(node: ReactNode, frame: number): string {
  clock.frame = frame;
  return renderToStaticMarkup(<ThemeProvider brand={fixtureBrandKit}>{node}</ThemeProvider>);
}

/** Множина різних значень opacity слів у кожному рядку розмітки. */
function opacitiesPerLine(html: string): string[][] {
  return html
    .split('<div style="white-space:nowrap">')
    .slice(1)
    .map((line) => [...new Set([...line.matchAll(/opacity:([\d.]+)/g)].map((m) => m[1] as string))]);
}

describe("Headline: by", () => {
  const headline = (by?: "word" | "line") => <Headline text={TEXT} preset="rise" by={by} width={WIDTH} />;
  const kinetic = (by: "word" | "line") => (
    <KineticText text={TEXT} preset="rise" by={by} maxFontSize={100} minFontSize={52} width={WIDTH} />
  );

  it('by="line" дає ту саму розмітку, що KineticText by="line"', () => {
    for (const frame of [0, 6, 14, 30]) {
      expect(render(headline("line"), frame)).toBe(render(kinetic("line"), frame));
    }
  });

  it('by="line": усі слова одного рядка з\'являються разом, рядки — по черзі', () => {
    const lines = opacitiesPerLine(render(headline("line"), 10));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toHaveLength(1);
    expect(new Set(lines.map((l) => l[0])).size).toBeGreaterThan(1);
  });

  it("без by — як було: по словах", () => {
    for (const frame of [0, 6, 14, 30]) {
      expect(render(headline(undefined), frame)).toBe(render(kinetic("word"), frame));
      expect(render(headline("word"), frame)).toBe(render(kinetic("word"), frame));
    }
    // У перший момент слова одного рядка ще на різних стадіях.
    const lines = opacitiesPerLine(render(headline(undefined), 6));
    expect(lines.some((l) => l.length > 1)).toBe(true);
    expect(render(headline("line"), 6)).not.toBe(render(headline(undefined), 6));
  });
});

describe("Body: by", () => {
  const body = (props: { by?: "word" | "line"; preset?: "rise" }) => (
    <Body text={TEXT} width={WIDTH} {...props} />
  );
  const kinetic = (by: "word" | "line") => (
    <KineticText
      text={TEXT}
      preset="rise"
      by={by}
      font="body"
      maxFontSize={42}
      minFontSize={30}
      width={WIDTH}
    />
  );

  it('by="line" дає ту саму розмітку, що KineticText by="line"', () => {
    for (const frame of [0, 10, 25]) {
      expect(render(body({ by: "line", preset: "rise" }), frame)).toBe(render(kinetic("line"), frame));
    }
  });

  it('by="word" з preset тепер працює по словах', () => {
    expect(render(body({ by: "word", preset: "rise" }), 6)).toBe(render(kinetic("word"), 6));
  });

  it("без by — як було: з preset по рядках, без preset статичний", () => {
    expect(render(body({ preset: "rise" }), 10)).toBe(render(kinetic("line"), 10));
    const still = render(body({}), 0);
    expect(still).toBe(render(body({}), 40));
    expect(still).not.toContain("opacity");
  });
});
