import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import type { BrandKit } from "@adc/shared/schemas/brandkit";
import { FORMAT_SIZE, FORMATS } from "@adc/shared/schemas/common";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Девайси (B4): детермінізм (кадр → той самий результат), clamp поза діапазоном,
 * кольори лише з палітри, QA-перевірка safe-зони там, де вона доречна.
 */

// Кадр і розміри — підміняємо контекст Remotion; QA-хук — шпигуном (DOM у тестах немає).
const clock = { frame: 0 };
const config = { width: 1080, height: 1920, fps: 30, durationInFrames: 150 };
const qaCalls: Array<{ component: string; safeArea?: boolean }> = [];
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return { ...actual, useCurrentFrame: () => clock.frame, useVideoConfig: () => config };
});
vi.mock("../src/qa.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/qa.tsx")>();
  return {
    ...actual,
    useQaCheck: (_ref: unknown, opts: { component: string; safeArea?: boolean }) => {
      qaCalls.push({ component: opts.component, safeArea: opts.safeArea });
    },
  };
});

const { ThemeProvider } = await import("../src/theme.tsx");
const { Breathe, useBeat } = await import("../src/devices/motion.tsx");
const { ClipReveal, ColorField } = await import("../src/devices/reveal.tsx");
const { DrawPath, MorphShape } = await import("../src/devices/shape.tsx");
const { springs } = await import("../src/motion.ts");
const { default: DeviceReveal } = await import("../examples/device-reveal.tsx");

const palette = fixtureBrandKit.palette;
const paletteHex = new Set(
  Object.values(palette)
    .filter((c): c is string => c !== null)
    .map((c) => c.toLowerCase()),
);

function render(node: ReactNode, frame: number, brand: BrandKit = fixtureBrandKit): string {
  clock.frame = frame;
  return renderToStaticMarkup(<ThemeProvider brand={brand}>{node}</ThemeProvider>);
}

/** Усі кольори з background/stroke розмітки. */
function colorsIn(html: string): string[] {
  return [...html.matchAll(/(?:background:|stroke=")(#[0-9a-fA-F]{3,8})/g)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
}

function BeatProbe(props: { at: number; duration?: number; config?: typeof springs.soft }) {
  const opts = {
    ...(props.duration !== undefined ? { duration: props.duration } : {}),
    ...(props.config ? { config: props.config } : {}),
  };
  return <i>{useBeat(props.at, opts).toFixed(6)}</i>;
}
const beat = (frame: number, props: Parameters<typeof BeatProbe>[0]) =>
  Number(render(<BeatProbe {...props} />, frame).replace(/<\/?i>/g, ""));

describe("useBeat", () => {
  it("пружина: 0 до `at`, близько 1 після осідання, той самий кадр — те саме число", () => {
    expect(beat(5, { at: 10 })).toBe(0);
    expect(beat(10 + 60, { at: 10 })).toBeCloseTo(1, 2);
    expect(beat(17, { at: 10 })).toBe(beat(17, { at: 10 }));
  });

  it("progress за duration: clamp 0 / 1 поза діапазоном, монотонно всередині", () => {
    expect(beat(-50, { at: 10, duration: 20 })).toBe(0);
    expect(beat(30, { at: 10, duration: 20 })).toBe(1);
    expect(beat(500, { at: 10, duration: 20 })).toBe(1);
    const a = beat(15, { at: 10, duration: 20 });
    const b = beat(20, { at: 10, duration: 20 });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
  });

  it("явний config замість пружини бренду", () => {
    // premium зі clamp не перелітає 1.
    for (let f = 0; f < 60; f++) expect(beat(f, { at: 0, config: springs.premium })).toBeLessThanOrEqual(1);
  });
});

describe("Breathe", () => {
  const scaleOf = (html: string) => Number(/scale\(([\d.]+)\)/.exec(html)?.[1]);

  it("до старту — спокій, на піку періоду — +amount, через період — знову спокій", () => {
    const node = (
      <Breathe startFrame={20} period={40} amount={0.01}>
        <b>x</b>
      </Breathe>
    );
    expect(scaleOf(render(node, 0))).toBe(1);
    expect(scaleOf(render(node, 20))).toBe(1);
    expect(scaleOf(render(node, 40))).toBeCloseTo(1.01, 5);
    expect(scaleOf(render(node, 60))).toBeCloseTo(1, 5);
    expect(render(node, 47)).toBe(render(node, 47));
  });

  it("дефолтний період — за характером руху бренду (calm — 75 кадрів)", () => {
    const html = render(<Breathe />, Math.round(75 / 2));
    expect(scaleOf(html)).toBeGreaterThan(1.0059);
  });

  it("центр масштабу — центр safe-зони", () => {
    // vertical: safe 120,240 840×1277 → центр 540, 878.5.
    expect(render(<Breathe />, 0)).toContain("transform-origin:540px 878.5px");
  });
});

describe("ColorField", () => {
  const fields = (html: string) =>
    [
      ...html.matchAll(/left:(-?[\d.]+)(?:px)?;top:(-?[\d.]+)(?:px)?;width:([\d.]+)px;height:([\d.]+)px/g),
    ].map((m) => m.slice(1).map(Number));

  it("wipe: до старту поля немає, після — увесь кадр кольором палітри; поза діапазоном — clamp", () => {
    const node = <ColorField mode="wipe" color="accent" startFrame={10} duration={10} />;
    expect(fields(render(node, 0))).toEqual([]);
    expect(fields(render(node, 20))).toEqual([[0, 0, 1080, 1920]]);
    expect(render(node, 999)).toBe(render(node, 20));
    expect(colorsIn(render(node, 20))).toEqual([palette.accent.toLowerCase()]);
  });

  it("wipe з exitFrame іде далі за напрямком і зникає", () => {
    const node = <ColorField from="top" startFrame={0} duration={10} exitFrame={20} />;
    const mid = fields(render(node, 25))[0] as number[];
    expect(mid[1]).toBeGreaterThan(0);
    expect((mid[1] as number) + (mid[3] as number)).toBeCloseTo(1920, 3);
    expect(fields(render(node, 40))).toEqual([]);
  });

  it("split: дві половини з протилежних країв", () => {
    const f = fields(render(<ColorField mode="split" duration={10} />, 10));
    expect(f).toEqual([
      [0, 0, 540, 1920],
      [540, 0, 540, 1920],
    ]);
  });

  it("push: панель cover і зсув кадру на ту саму відстань", () => {
    const node = (
      <ColorField mode="push" from="right" cover={0.4} duration={10}>
        <b>кадр</b>
      </ColorField>
    );
    const html = render(node, 10);
    expect(fields(html)).toEqual([[648, 0, 432, 1920]]);
    expect(html).toContain("translateX(-432.00px)");
    expect(render(node, 0)).not.toContain("translate");
  });

  it("лише кольори палітри в усіх режимах", () => {
    for (const mode of ["wipe", "split", "push"] as const) {
      for (const color of ["primary", "secondary", "surface"] as const) {
        for (const c of colorsIn(render(<ColorField mode={mode} color={color} duration={6} />, 3))) {
          expect(paletteHex.has(c)).toBe(true);
        }
      }
    }
  });
});

describe("ClipReveal", () => {
  const clip = (html: string) => /clip-path:([^;"]+)/.exec(html)?.[1] ?? null;

  it("inset із центру: закрито до старту, без clip-path після, clamp", () => {
    const node = (
      <ClipReveal startFrame={5} duration={10}>
        <b>x</b>
      </ClipReveal>
    );
    expect(clip(render(node, 0))).toBe("inset(50.00% 50.00% 50.00% 50.00%)");
    expect(clip(render(node, 15))).toBeNull();
    expect(clip(render(node, 300))).toBeNull();
    expect(render(node, 9)).toBe(render(node, 9));
  });

  it("inset від краю відкриває лише з цього боку", () => {
    expect(clip(render(<ClipReveal from="left" duration={10} />, 0))).toBe(
      "inset(0.00% 100.00% 0.00% 0.00%)",
    );
    expect(clip(render(<ClipReveal from="bottom" duration={10} />, 0))).toBe(
      "inset(100.00% 0.00% 0.00% 0.00%)",
    );
  });

  it("circle росте від точки до радіуса, що накриває найдальший кут", () => {
    expect(clip(render(<ClipReveal shape="circle" duration={10} />, 0))).toBe(
      "circle(0.00% at 50.00% 50.00%)",
    );
    const almost = clip(render(<ClipReveal shape="circle" from="left" duration={10} easing={(t) => t} />, 9));
    // √2 × 1 × 1.01 × 0.9 ≈ 128.55 %.
    expect(almost).toBe("circle(128.55% at 0.00% 50.00%)");
  });

  it("polygon: косий край закритий до старту; з центру — ромб", () => {
    expect(clip(render(<ClipReveal shape="polygon" from="left" duration={10} />, 0))).toBe(
      "polygon(0% 0%, 0.00% 0%, -25.00% 100%, 0% 100%)",
    );
    expect(clip(render(<ClipReveal shape="polygon" duration={10} />, 0))).toBe(
      "polygon(50% 50.00%, 50.00% 50%, 50% 50.00%, 50.00% 50%)",
    );
  });
});

describe("DrawPath", () => {
  const d = "M 0 50 L 400 50";
  const node = <DrawPath d={d} width={400} height={100} startFrame={10} duration={20} />;
  const offset = (html: string) => Number(/stroke-dashoffset="([\d.e-]+)"/.exec(html)?.[1]);

  it("до старту прихована, після — намальована повністю; поза діапазоном — clamp", () => {
    expect(render(node, 0)).toContain("opacity:0");
    // evolvePath на 0 зсуває штрих на 1.5 довжини — гарантовано невидимий.
    expect(offset(render(node, 0))).toBeGreaterThanOrEqual(400);
    expect(offset(render(node, 30))).toBeCloseTo(0, 6);
    expect(render(node, 900)).toBe(render(node, 30));
    const mid = offset(render(node, 20));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(400);
  });

  it("колір — роль палітри, товщина за замовчуванням × unit", () => {
    const html = render(<DrawPath d={d} width={400} height={100} color="primary" />, 30);
    expect(colorsIn(html)).toEqual([palette.primary.toLowerCase()]);
    expect(html).toContain('stroke-width="8"');
  });

  it("QA safe-зони, якщо не bleed", () => {
    qaCalls.length = 0;
    render(node, 30);
    render(<DrawPath d={d} width={400} height={100} bleed />, 30);
    expect(qaCalls).toEqual([
      { component: "DrawPath", safeArea: true },
      { component: "DrawPath", safeArea: false },
    ]);
  });
});

describe("MorphShape", () => {
  const keys = [
    { x: 100, y: 200, width: 200, height: 200, radius: 100, color: "accent" as const },
    { at: 30, x: 140, y: 1400, width: 800, height: 160, radius: 24, color: "primary" as const },
    { x: 140, y: 1400, width: 800, height: 400 },
  ];
  const box = (html: string) => {
    const m =
      /left:([\d.]+)(?:px)?;top:([\d.]+)(?:px)?;width:([\d.]+)px;height:([\d.]+)px;border-radius:([\d.]+)px/.exec(
        html,
      );
    return m ? m.slice(1).map(Number) : null;
  };

  it("до першого переходу — перший стан, після останнього — останній; clamp", () => {
    expect(box(render(<MorphShape keys={keys} />, 0))).toEqual([100, 200, 200, 200, 100]);
    expect(box(render(<MorphShape keys={keys} />, 29))).toEqual([100, 200, 200, 200, 100]);
    // Третій ключ без `at` — одразу після другого (30 + 18).
    expect(box(render(<MorphShape keys={keys} />, 48))).toEqual([140, 1400, 800, 160, 24]);
    expect(box(render(<MorphShape keys={keys} />, 66))).toEqual([140, 1400, 800, 400, 24]);
    expect(render(<MorphShape keys={keys} />, 500)).toBe(render(<MorphShape keys={keys} />, 66));
  });

  it("посередині — між станами; колір — суміш ролей палітри, на кінцях — точно палітра", () => {
    const mid = box(render(<MorphShape keys={keys} />, 39)) as number[];
    expect(mid[0]).toBeGreaterThan(100);
    expect(mid[0]).toBeLessThan(140);
    expect(colorsIn(render(<MorphShape keys={keys} />, 0))).toEqual([palette.accent.toLowerCase()]);
    expect(colorsIn(render(<MorphShape keys={keys} />, 66))).toEqual([palette.primary.toLowerCase()]);
    expect(render(<MorphShape keys={keys} />, 39)).toBe(render(<MorphShape keys={keys} />, 39));
  });

  it("радіус — не більший за половину короткої сторони; дефолт — theme.radius.lg × unit", () => {
    const html = render(<MorphShape keys={[{ x: 0, y: 0, width: 300, height: 60 }]} />, 0);
    // rounded-бренд: lg = 44 > 30 → 30.
    expect(box(html)?.[4]).toBe(30);
    expect(box(render(<MorphShape keys={[{ x: 0, y: 0, width: 300, height: 300 }]} />, 0))?.[4]).toBe(44);
  });

  it("QA safe-зони, якщо не bleed", () => {
    qaCalls.length = 0;
    render(<MorphShape keys={keys} />, 0);
    render(<MorphShape keys={keys} bleed />, 0);
    expect(qaCalls).toEqual([
      { component: "MorphShape", safeArea: true },
      { component: "MorphShape", safeArea: false },
    ]);
  });
});

describe("examples/device-reveal.tsx", () => {
  it.each(FORMATS)("%s: рендериться з фото й без, детерміновано, лише кольори палітри", (format) => {
    Object.assign(config, FORMAT_SIZE[format]);
    for (const scene of fixtureStoryboard.scenes.slice(0, 2)) {
      const node = <DeviceReveal scene={scene} brand={fixtureBrandKit} assets={{}} durationInFrames={120} />;
      for (const frame of [0, 20, 60, 110]) {
        const html = render(node, frame);
        expect(html).toBe(render(node, frame));
        for (const c of colorsIn(html)) expect(paletteHex.has(c)).toBe(true);
      }
    }
    Object.assign(config, FORMAT_SIZE.vertical);
  });
});
