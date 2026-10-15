import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { FORMAT_SIZE, FORMATS } from "@adc/shared/schemas/common";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Internals, useCurrentFrame } from "remotion";
import { describe, expect, it } from "vitest";
import MotionBlurExample from "../examples/motion-blur.tsx";
import { MotionBlur, Trail } from "../src/devices/blur.tsx";
import { QaProvider, useQaEnabled } from "../src/qa.tsx";
import { ThemeProvider } from "../src/theme.tsx";

/**
 * Motion blur (B1): кількість копій і clamp параметрів, QA лише в основній копії, детермінізм.
 * Кадр задаємо справжнім TimelineContext Remotion, а не `vi.mock("remotion")`, як в інших тестах:
 * @remotion/motion-blur — зовнішній модуль, мок його `useCurrentFrame`/`Freeze` не зачіпає,
 * а кожна копія впізнає себе саме за кадром свого Freeze.
 */

const ID = "blur-test";
const COMPOSITION = { width: 1080, height: 1920, fps: 30, durationInFrames: 150 };

function render(node: ReactNode, frame: number, qa = false, size = FORMAT_SIZE.vertical): string {
  const config = { ...COMPOSITION, ...size };
  const compositions = [{ id: ID, ...config, component: () => null, defaultProps: {} }];
  const manager = {
    compositions,
    canvasContent: { type: "composition", compositionId: ID },
    currentCompositionMetadata: {
      ...config,
      props: {},
      defaultCodec: null,
      defaultOutName: null,
      defaultVideoImageFormat: null,
      defaultPixelFormat: null,
      defaultProResProfile: null,
      defaultSampleRate: null,
    },
    currentAssetMetadata: null,
    folders: [],
  } as unknown as Parameters<typeof Internals.CompositionManager.Provider>[0]["value"];
  const timeline = {
    frame: { [ID]: frame },
    isPlaying: () => false,
    isInsideFreeze: false,
    audioAndVideoTags: { current: [] },
  };
  return renderToStaticMarkup(
    <Internals.CanUseRemotionHooksProvider>
      <Internals.CompositionManager.Provider value={manager}>
        <Internals.TimelineContext.Provider value={timeline}>
          <QaProvider enabled={qa}>{node}</QaProvider>
        </Internals.TimelineContext.Provider>
      </Internals.CompositionManager.Provider>
    </Internals.CanUseRemotionHooksProvider>,
  );
}

/** Копія дітей: свій кадр і чи ввімкнено в ній QA. */
function Probe() {
  const frame = useCurrentFrame();
  const qa = useQaEnabled();
  return <i data-frame={frame.toFixed(3)} data-qa={String(qa)} />;
}

const probes = (html: string) =>
  [...html.matchAll(/<i data-frame="([^"]+)" data-qa="(true|false)"><\/i>/g)].map((m) => ({
    frame: Number(m[1]),
    qa: m[2] === "true",
  }));

describe("MotionBlur", () => {
  it("дефолт: 3 семпли, затвор 180° — кадри frame + 1 − 0.5·k/3", () => {
    const copies = probes(render(<MotionBlur>{<Probe />}</MotionBlur>, 30));
    expect(copies.map((c) => c.frame)).toEqual([30.833, 30.667, 30.5]);
  });

  it("samples clamp до 6, дробові округлюються", () => {
    expect(probes(render(<MotionBlur samples={12}>{<Probe />}</MotionBlur>, 60))).toHaveLength(6);
    expect(probes(render(<MotionBlur samples={3.6}>{<Probe />}</MotionBlur>, 60))).toHaveLength(4);
  });

  it("shutterAngle clamp до 360: останній семпл — рівно на кадрі", () => {
    const copies = probes(render(<MotionBlur shutterAngle={720}>{<Probe />}</MotionBlur>, 30));
    expect(copies.map((c) => c.frame)).toEqual([30.667, 30.333, 30]);
  });

  it("samples ≤ 1 або shutterAngle 0 — діти без обгортки", () => {
    const plain = render(<Probe />, 30);
    expect(render(<MotionBlur samples={1}>{<Probe />}</MotionBlur>, 30)).toBe(plain);
    expect(render(<MotionBlur shutterAngle={0}>{<Probe />}</MotionBlur>, 30)).toBe(plain);
  });

  it("QA лише в основній копії; у QA-режимі вона закріплена на цілому кадрі", () => {
    const off = probes(render(<MotionBlur>{<Probe />}</MotionBlur>, 30));
    expect(off.every((c) => !c.qa)).toBe(true);
    const on = probes(render(<MotionBlur samples={4}>{<Probe />}</MotionBlur>, 30, true));
    expect(on.filter((c) => c.qa)).toEqual([{ frame: 30, qa: true }]);
    expect(on.filter((c) => !c.qa)).toHaveLength(3);
  });

  it("біля кадру 0 семплів менше, основна копія лишається з QA", () => {
    const copies = probes(render(<MotionBlur>{<Probe />}</MotionBlur>, 0, true));
    expect(copies).toEqual([{ frame: 0, qa: true }]);
  });

  it("той самий кадр двічі → та сама розмітка", () => {
    for (const frame of [0, 1, 7, 42]) {
      const node = (
        <MotionBlur samples={4}>
          <Probe />
        </MotionBlur>
      );
      expect(render(node, frame, true)).toBe(render(node, frame, true));
      expect(render(node, frame)).toBe(render(node, frame));
    }
  });
});

describe("Trail", () => {
  it("дефолт: 3 шари з відставанням 1 кадр + основний шар; QA лише в основному", () => {
    const html = render(<Trail>{<Probe />}</Trail>, 30, true);
    expect(probes(html)).toEqual([
      { frame: 27, qa: false },
      { frame: 28, qa: false },
      { frame: 29, qa: false },
      { frame: 30, qa: true },
    ]);
    // Прозорість шарів спадає до trailOpacity 0.4.
    const opacities = [...html.matchAll(/opacity:([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...opacities)).toBeCloseTo(0.4 - 0.4 / 3, 5);
  });

  it("layers clamp до 6; layers 0 чи lagInFrames 0 — діти без обгортки", () => {
    expect(probes(render(<Trail layers={10}>{<Probe />}</Trail>, 30))).toHaveLength(7);
    const plain = render(<Probe />, 30);
    expect(render(<Trail layers={0}>{<Probe />}</Trail>, 30)).toBe(plain);
    expect(render(<Trail lagInFrames={0}>{<Probe />}</Trail>, 30)).toBe(plain);
  });

  it("той самий кадр двічі → та сама розмітка", () => {
    for (const frame of [0, 5, 60]) {
      const node = (
        <Trail lagInFrames={2}>
          <Probe />
        </Trail>
      );
      expect(render(node, frame, true)).toBe(render(node, frame, true));
    }
  });
});

describe("еталон motion-blur", () => {
  const scene = fixtureStoryboard.scenes[1];
  if (!scene) throw new Error("fixtureStoryboard без сцен");
  const node = <MotionBlurExample scene={scene} brand={fixtureBrandKit} assets={{}} durationInFrames={150} />;
  const show = (frame: number, format: (typeof FORMATS)[number], qa = false) =>
    render(<ThemeProvider brand={fixtureBrandKit}>{node}</ThemeProvider>, frame, qa, FORMAT_SIZE[format]);
  /** Кількість змонтованих CameraMotionBlur (їхній корінь — AbsoluteFill з isolation). */
  const blurs = (html: string) => html.split("isolation:isolate").length - 1;
  const start = scene.transitionFrames;

  it.each(FORMATS.map((f) => [f]))(
    "%s: детермінований, blur лише на кадрах руху, не більше двох",
    (format) => {
      for (const frame of [0, start, start + 3, start + 6, start + 12, 60, 149]) {
        expect(show(frame, format, true)).toBe(show(frame, format, true));
        expect(blurs(show(frame, format))).toBeLessThanOrEqual(2);
      }
      // Поле й картка летять одночасно (start + 4 … start + 7) — дві обгортки; до руху й після посадки — жодної.
      expect(blurs(show(start + 5, format))).toBe(2);
      expect(blurs(show(start + 12, format))).toBe(0);
      expect(blurs(show(149, format))).toBe(0);
    },
  );
});
