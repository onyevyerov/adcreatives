import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { FORMAT_SIZE, FORMATS } from "@adc/shared/schemas/common";
import type { Scene } from "@adc/shared/schemas/storyboard";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Камера (B2): математика ключа, послідовна інтерполяція, один рух за раз, `useCamera` для QA,
 * еталон `camera-cursor`. Чиста функція кадру: той самий кадр двічі → та сама розмітка.
 */

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
const { Camera, useCamera } = await import("../src/devices/camera.tsx");
const { hiddenByCamera } = await import("../src/qa.tsx");
const { easings } = await import("../src/motion.ts");
const { default: CameraCursor } = await import("../examples/camera-cursor.tsx");
type CameraKey = import("../src/devices/camera.tsx").CameraKey;

function render(node: ReactNode, frame: number): string {
  clock.frame = frame;
  return renderToStaticMarkup(<ThemeProvider brand={fixtureBrandKit}>{node}</ThemeProvider>);
}

/** Трансформація шару камери з розмітки. */
function transformOf(html: string): { tx: number; ty: number; scale: number } {
  const m = /transform:translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(html);
  if (!m) throw new Error(`немає transform камери: ${html.slice(0, 200)}`);
  return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) };
}

function Probe() {
  const c = useCamera();
  return <i>{JSON.stringify(c)}</i>;
}
const probe = (html: string) =>
  JSON.parse(/<i>(.*?)<\/i>/.exec(html.replace(/&quot;/g, '"'))?.[1] ?? "null") as ReturnType<
    typeof useCamera
  >;

const FULL: CameraKey = { at: 0, x: 0, y: 0, width: 1080, height: 1920 };
const PUSH: CameraKey = { at: 30, x: 270, y: 480, width: 540, height: 960 };

describe("Camera: математика ключа", () => {
  it("ключ на весь кадр — identity, transformOrigin 0 0", () => {
    const html = render(<Camera keys={[FULL]}>x</Camera>, 0);
    expect(transformOf(html)).toEqual({ tx: 0, ty: 0, scale: 1 });
    expect(html).toContain("transform-origin:0 0");
  });

  it("s = min(ширина/key.width, висота/key.height), центр ключа — у центрі кадру", () => {
    expect(transformOf(render(<Camera keys={[PUSH]}>x</Camera>, 0))).toEqual({
      tx: -540,
      ty: -960,
      scale: 2,
    });
    // Ключ іншої пропорції: масштаб за тісною стороною, центр — однаково в центрі кадру.
    const square: CameraKey = { at: 0, x: 100, y: 200, width: 540, height: 540 };
    const t = transformOf(render(<Camera keys={[square]}>x</Camera>, 0));
    expect(t.scale).toBe(2);
    expect(t.scale * (100 + 270) + t.tx).toBeCloseTo(540, 1);
    expect(t.scale * (200 + 270) + t.ty).toBeCloseTo(960, 1);
  });

  it("перший ключ діє з кадру 0; наступний стартує на `at` і досягається за duration з easing", () => {
    const node = <Camera keys={[FULL, PUSH]}>x</Camera>;
    for (const frame of [0, 15, 30]) expect(transformOf(render(node, frame)).scale).toBe(1);
    expect(transformOf(render(node, 48))).toEqual({ tx: -540, ty: -960, scale: 2 });
    expect(transformOf(render(node, 200))).toEqual({ tx: -540, ty: -960, scale: 2 });
    // Посередині (inOut, t = 0.5): прямокутник — середина між ключами (810 × 1440), масштаб 1080 / 810.
    expect(transformOf(render(node, 39)).scale).toBeCloseTo(1080 / 810, 3);
    const quick = (
      <Camera keys={[FULL, PUSH]} duration={10} easing={easings.out}>
        x
      </Camera>
    );
    expect(transformOf(render(quick, 40)).scale).toBe(2);
  });

  it("послідовно: відхід стартує з того, куди камера наїхала", () => {
    const node = <Camera keys={[FULL, PUSH, { ...FULL, at: 60 }]}>x</Camera>;
    expect(transformOf(render(node, 59)).scale).toBe(2);
    expect(transformOf(render(node, 78))).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  it("рухи, що перекриваються в часі, — помилка рендеру (R3)", () => {
    const node = <Camera keys={[FULL, PUSH, { ...FULL, at: 40 }]}>x</Camera>;
    expect(() => render(node, 0)).toThrow(/Camera: два рухи одночасно/);
    // Рівно на кінці попереднього руху — можна.
    expect(() => render(<Camera keys={[FULL, PUSH, { ...FULL, at: 48 }]}>x</Camera>, 0)).not.toThrow();
    // Перший ключ — не рух: наступний може стартувати будь-коли.
    expect(() => render(<Camera keys={[FULL, { ...PUSH, at: 5 }]}>x</Camera>, 0)).not.toThrow();
  });

  it("ключ без розміру — помилка рендеру", () => {
    expect(() => render(<Camera keys={[{ ...FULL, width: 0 }]}>x</Camera>, 0)).toThrow(/без розміру/);
  });

  it("той самий кадр двічі → та сама розмітка", () => {
    const node = (
      <Camera keys={[FULL, PUSH, { ...FULL, at: 60 }]}>
        <b>x</b>
      </Camera>
    );
    for (const frame of [0, 12, 33, 47, 61, 90]) expect(render(node, frame)).toBe(render(node, frame));
  });
});

describe("useCamera і QA", () => {
  it("поза Camera — identity, усередині — поточні scale/tx/ty", () => {
    expect(probe(render(<Probe />, 0))).toEqual({ active: false, scale: 1, tx: 0, ty: 0 });
    const inside = probe(
      render(
        <Camera keys={[FULL, PUSH]}>
          <Probe />
        </Camera>,
        60,
      ),
    );
    expect(inside).toEqual({ active: true, scale: 2, tx: -540, ty: -960 });
  });

  it("hiddenByCamera: лише при наїзді і лише для прямокутника цілком поза кадром", () => {
    const zoom = { active: true, scale: 2 };
    const outside = { x: -400, y: 100, width: 300, height: 80 };
    const partly = { x: -100, y: 100, width: 300, height: 80 };
    expect(hiddenByCamera(outside, zoom, 1080, 1920)).toBe(true);
    expect(hiddenByCamera({ x: 1080, y: 0, width: 10, height: 10 }, zoom, 1080, 1920)).toBe(true);
    expect(hiddenByCamera({ x: 0, y: 1920, width: 10, height: 10 }, zoom, 1080, 1920)).toBe(true);
    expect(hiddenByCamera(partly, zoom, 1080, 1920)).toBe(false);
    expect(hiddenByCamera(outside, { active: true, scale: 1 }, 1080, 1920)).toBe(false);
    expect(hiddenByCamera(outside, { active: false, scale: 2 }, 1080, 1920)).toBe(false);
  });
});

describe("examples/camera-cursor.tsx", () => {
  const base = fixtureStoryboard.scenes[1] as Scene;
  const scene: Scene = {
    ...base,
    id: "s2",
    items: [
      { id: "t1", role: "label", text: "webreportio.com", group: null, factIds: [] },
      { id: "t2", role: "button", text: "Аудит", group: null, factIds: [] },
      { id: "t3", role: "item", text: "Технічне SEO", group: "list", factIds: [] },
      { id: "t4", role: "item", text: "Швидкість", group: "list", factIds: [] },
      { id: "t5", role: "item", text: "Безпека", group: "list", factIds: [] },
    ],
    events: [
      { id: "hover", at: 20, what: "Cursor on the field.", sound: null, textIds: [] },
      { id: "type", at: 26, what: "Click, typing starts.", sound: null, textIds: ["t1"] },
      {
        id: "press",
        at: 70,
        what: "Button pressed.",
        sound: { cue: "click", accent: "normal" },
        textIds: [],
      },
      { id: "checks", at: 120, what: "First check.", sound: { cue: "tick", accent: "normal" }, textIds: [] },
    ],
  };
  const node = <CameraCursor scene={scene} brand={fixtureBrandKit} assets={{}} durationInFrames={180} />;

  it.each(FORMATS)("%s: детерміновано, камера наїжджає після приходу курсора й відходить", (format) => {
    Object.assign(config, FORMAT_SIZE[format]);
    for (const frame of [0, 20, 30, 50, 80, 100, 179]) expect(render(node, frame)).toBe(render(node, frame));
    expect(transformOf(render(node, 20)).scale).toBe(1);
    expect(transformOf(render(node, 50)).scale).toBeGreaterThan(1.05);
    expect(transformOf(render(node, 179)).scale).toBe(1);
    // Рядки розкладки — окремі блоки, тож порівнюємо без пробілів.
    const end = render(node, 179)
      .replace(/<[^>]+>/g, "")
      .replace(/\s/g, "");
    for (const t of ["webreportio.com", "Аудит", "ТехнічнеSEO", "Безпека"]) expect(end).toContain(t);
    Object.assign(config, FORMAT_SIZE.vertical);
  });

  it("сцена без потрібної події — помилка рендеру (eventFrame)", () => {
    const broken = { ...scene, events: scene.events.filter((e) => e.id !== "hover") };
    expect(() =>
      render(<CameraCursor scene={broken} brand={fixtureBrandKit} assets={{}} durationInFrames={180} />, 0),
    ).toThrow(/hover/);
  });
});
