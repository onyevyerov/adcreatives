import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAudio, pcmLength, rmsOf } from "@adc/audio";
import { parseQaLog, TEMPLATE_VARIANTS, type TemplateVariant } from "@adc/motion-kit";
import type { BrowserLog } from "@adc/shared/render/RenderEngine";
import { FORMAT_SIZE, FORMATS, type Format } from "@adc/shared/schemas/common";
import type { ScenePurpose, Storyboard } from "@adc/shared/schemas/storyboard";
import { computeTimeline, stillFrames } from "@adc/shared/timeline";
import type { ScenePreviewProps } from "@adc/shared/types/video";
import { parseMedia } from "@remotion/media-parser";
import { nodeReader } from "@remotion/media-parser/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OUTPUT_SAMPLE_RATE, RemotionRenderEngine, RenderError } from "../src/engine.ts";
import {
  createFixtureJob,
  type FixtureJob,
  fixtureMainProps,
  makeToneWav,
  shortStoryboard,
} from "../src/testing.ts";

/**
 * Повільні тести (тег `slow`): справжній бандл (rspack) і рендер у Chrome Headless Shell.
 * Стіли пишуться в packages/render/out/test-stills/ (у .gitignore) для огляду очима.
 */

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out", "test-stills");

// Сцени задачі лежать у тимчасовій теці поза монорепо — як у DATA_DIR.
const OVERFLOW_SCENE = `
import type { SceneProps } from "@adc/motion-kit";
import { Backdrop, FitText, SafeArea } from "@adc/motion-kit";
import { AbsoluteFill } from "remotion";

export default function Scene(_props: SceneProps) {
  return (
    <AbsoluteFill>
      <Backdrop variant="solid" />
      <SafeArea style={{ justifyContent: "center" }}>
        <FitText
          text="Найдовший заголовок, який точно не влізе в один рядок навіть дрібним шрифтом"
          maxLines={1}
          maxFontSize={120}
          minFontSize={90}
        />
      </SafeArea>
    </AbsoluteFill>
  );
}
`;

const CODE_SCENE = `
import type { SceneProps } from "@adc/motion-kit";
import { Backdrop, Headline, Pill, SafeArea, springs, useFormat, useTheme } from "@adc/motion-kit";
import { Star } from "@remotion/shapes";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: springs.snappy });
  return (
    <AbsoluteFill>
      <Backdrop variant="gradient" colors={[theme.palette.background, theme.palette.surface]} />
      <SafeArea style={{ justifyContent: "center", alignItems: "center", gap: 40 * unit }}>
        <div style={{ transform: \`scale(\${s})\` }}>
          <Star points={5} innerRadius={30} outerRadius={70} fill={theme.palette.accent} />
        </div>
        <Pill text="75 грн" startFrame={4} />
        <Headline text={props.scene.text.headline} emphasis={props.scene.text.emphasis} preset="rise" color={theme.palette.textOnLight} />
      </SafeArea>
    </AbsoluteFill>
  );
}
`;

const BROKEN_SCENE = `
import type { SceneProps } from "@adc/motion-kit";
export default function Scene(props: SceneProps): null {
  throw new Error("зламана сцена " + props.scene.id);
}
`;

// Навмисні порушення: низький контраст, елемент поза safe-зоною, збільшене фото, невідомий асет.
const QA_SCENE = `
import type { SceneProps } from "@adc/motion-kit";
import { Backdrop, BrandImage, Headline, Pill, SafeArea } from "@adc/motion-kit";
import { AbsoluteFill } from "remotion";

export default function Scene(_props: SceneProps) {
  return (
    <AbsoluteFill>
      <Backdrop variant="solid" color="#FFF8F0" />
      <BrandImage assetId="a02" style={{ left: 0, top: 0, width: 1080, height: 600 }} />
      <BrandImage assetId="nope" style={{ left: 0, top: 1700, width: 200, height: 200 }} />
      <Pill text="Поза safe-зоною" style={{ position: "absolute", left: 10, top: 10 }} />
      <SafeArea style={{ justifyContent: "flex-end" }}>
        <Headline text="Ледь видно" color="#F3E6D8" />
      </SafeArea>
    </AbsoluteFill>
  );
}
`;

const PURPOSE_FOR: Record<TemplateVariant, ScenePurpose> = {
  hero: "hook",
  text: "offer",
  image: "product",
  cta: "cta",
};

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function qaEntries(logs: BrowserLog[]) {
  return logs.map((l) => parseQaLog(l.text)).filter((e) => e !== null);
}

describe("slow: RemotionRenderEngine", () => {
  let tmp: string;
  let job: FixtureJob;
  let serveUrl: string;
  const engine = new RemotionRenderEngine();

  const storyboard: Storyboard = shortStoryboard([
    { id: "s1", purpose: "hook" },
    {
      id: "s2",
      purpose: "offer",
      text: { headline: "Капучино — 75 грн", sub: "-10% до 10:00", emphasis: ["75 грн"] },
    },
    { id: "s3", purpose: "cta", text: { headline: "Забронюйте столик", sub: null, emphasis: [] } },
    { id: "s4", purpose: "proof" },
    { id: "s5", purpose: "benefit" },
  ]);

  const preview = (
    sceneId: string,
    format: Format,
    extra: Partial<ScenePreviewProps> = {},
  ): ScenePreviewProps => ({
    brand: fixtureMainProps(job, storyboard, format).brand,
    storyboard,
    sceneId,
    format,
    assets: job.assets,
    useTemplate: false,
    qa: true,
    ...extra,
  });

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "adc-render-"));
    await mkdir(OUT, { recursive: true });
    job = await createFixtureJob({
      jobDir: path.join(tmp, "rev", "1", "video"),
      scenes: { s1: OVERFLOW_SCENE, s2: CODE_SCENE, s4: BROKEN_SCENE, s5: QA_SCENE },
    });
    ({ serveUrl } = await engine.bundleJob({ jobDir: job.jobDir }));
  });

  afterAll(async () => {
    await engine.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("bundleJob: бандл у <jobDir>/bundle з public/", () => {
    expect(path.resolve(serveUrl)).toBe(path.join(job.jobDir, "bundle"));
    expect(existsSync(path.join(job.jobDir, "bundle", "public", "hero.png"))).toBe(true);
  });

  it("renderMedia: 2-секундний mp4 (h264 + aac 44.1 кГц, без ресемплінгу зведення) з TemplateScene", async () => {
    const sb = shortStoryboard([
      { id: "s1", purpose: "hook" },
      { id: "s2", purpose: "cta", text: { headline: "Забронюйте столик", sub: null, emphasis: [] } },
    ]);
    const totalFrames = computeTimeline(sb).totalFrames;
    expect(totalFrames).toBe(60);
    const out = path.join(tmp, "main.mp4");
    let last = 0;
    const { durationMs } = await engine.renderMedia({
      serveUrl,
      inputProps: fixtureMainProps({ ...job, audio: { ...job.audio, totalFrames } }, sb, "vertical"),
      format: "vertical",
      out,
      onProgress: (p) => {
        last = p;
      },
    });
    expect(durationMs).toBeGreaterThan(0);
    expect(last).toBe(1);
    expect((await stat(out)).size).toBeGreaterThan(10_000);
    const meta = await parseMedia({
      src: out,
      reader: nodeReader,
      fields: { durationInSeconds: true, dimensions: true, tracks: true },
      acknowledgeRemotionLicense: true,
    });
    expect(meta.durationInSeconds).toBeCloseTo(2, 1);
    expect(meta.dimensions).toMatchObject({ width: 1080, height: 1920 });
    const codecs = meta.tracks.map((t) => ("codecEnum" in t ? `${t.type}:${t.codecEnum}` : t.type));
    expect(codecs).toEqual(expect.arrayContaining(["video:h264", "audio:aac"]));
    // Частота з sample entry `mp4a` (stsd) — та сама, що в зведенні (44.1 кГц), а не дефолт Remotion 48 кГц.
    const audio = meta.tracks.filter((t) => t.type === "audio");
    expect(audio.map((t) => t.sampleRate)).toEqual([44_100]);
    expect(OUTPUT_SAMPLE_RATE).toBe(44_100);
  });

  it("renderMedia: зведення звучить без розривів хвилі на стиках кадрів", async () => {
    // Чистий тон як `soundtrack.wav`: друга різниця синуса 220 Гц × 0.3 ≈ 3·10⁻⁴; зсув хвилі
    // хоч на семпл (покадрова склейка аудіо) дає стрибок ~10⁻², AAC 320k — на порядки менше.
    const sb = shortStoryboard([
      { id: "s1", purpose: "hook" },
      { id: "s2", purpose: "cta", text: { headline: "Забронюйте столик", sub: null, emphasis: [] } },
    ]);
    const totalFrames = computeTimeline(sb).totalFrames;
    await writeFile(path.join(job.jobDir, "bundle", "public", "soundtrack.wav"), makeToneWav(3));
    const mix = {
      src: "soundtrack.wav",
      durationMs: 2000,
      integratedLufs: null,
      truePeakDbtp: null,
      masterGainDb: null,
    };
    const out = path.join(tmp, "mix.mp4");
    await engine.renderMedia({
      serveUrl,
      inputProps: fixtureMainProps({ ...job, audio: { ...job.audio, mix, totalFrames } }, sb, "vertical"),
      format: "vertical",
      out,
    });
    const pcm = await decodeAudio(await readFile(out));
    // Тон справді звучить, а не тиша (моно тон у стерео — −3 дБ на канал: RMS ≈ 0.15).
    expect(rmsOf(pcm, 8820, 83790)).toBeGreaterThan(0.1);
    // Перші 0.2 с — атака тону і вступ кодека; далі тон стаціонарний.
    const jumps: number[] = [];
    for (let i = 8820; i < pcmLength(pcm) - 4410; i++) {
      const x = pcm.left;
      const d2 = (x[i + 1] as number) - 2 * (x[i] as number) + (x[i - 1] as number);
      if (Math.abs(d2) > 0.003) jumps.push(i);
    }
    expect(jumps.slice(0, 20)).toEqual([]);
  });

  it("renderStill: Main у square, кадр за таймлайном", async () => {
    const out = path.join(OUT, "main-square.png");
    const props = fixtureMainProps(job, storyboard, "square", { templateScenes: ["s1", "s4"] });
    const { logs } = await engine.renderStill({
      serveUrl,
      composition: "Main",
      inputProps: props,
      format: "square",
      frame: 40,
      out,
    });
    expect(pngSize(out)).toEqual({ width: 1080, height: 1080 });
    expect(logs.filter((l) => l.type === "error")).toEqual([]);
  });

  it("renderStill: ADC_QA text_overflow на навмисно переповненому тексті", async () => {
    const out = path.join(OUT, "overflow-vertical.png");
    const { logs } = await engine.renderStill({
      serveUrl,
      composition: "ScenePreview",
      inputProps: preview("s1", "vertical"),
      format: "vertical",
      frame: 17,
      out,
    });
    expect(existsSync(out)).toBe(true);
    const qa = qaEntries(logs);
    expect(qa).toContainEqual(
      expect.objectContaining({ kind: "text_overflow", component: "FitText", frame: 17 }),
    );
    expect(logs.some((l) => l.text.startsWith("ADC_QA "))).toBe(true);
  });

  it("renderStill: ADC_QA low_contrast, outside_safe_area, upscaled_image, невідомий асет", async () => {
    const out = path.join(OUT, "qa-vertical.png");
    const { logs } = await engine.renderStill({
      serveUrl,
      composition: "ScenePreview",
      inputProps: preview("s5", "vertical"),
      format: "vertical",
      frame: 17,
      out,
    });
    const qa = qaEntries(logs);
    expect(qa).toContainEqual(expect.objectContaining({ kind: "low_contrast", component: "Headline" }));
    expect(qa).toContainEqual(expect.objectContaining({ kind: "outside_safe_area", component: "Pill" }));
    expect(qa).toContainEqual(expect.objectContaining({ kind: "upscaled_image", component: "BrandImage" }));
    expect(qa).toContainEqual(
      expect.objectContaining({ kind: "missing_asset", detail: expect.stringContaining("nope") }),
    );
  });

  it("renderStill: QA вимкнено → жодних ADC_QA-логів", async () => {
    const { logs } = await engine.renderStill({
      serveUrl,
      composition: "ScenePreview",
      inputProps: preview("s5", "vertical", { qa: false }),
      format: "vertical",
      frame: 17,
      out: path.join(tmp, "qa-off.png"),
    });
    expect(qaEntries(logs)).toEqual([]);
  });

  it("renderStill: сцена codegen з теки поза монорепо резолвить motion-kit і @remotion/shapes", async () => {
    const out = path.join(OUT, "code-scene-landscape.png");
    const { logs } = await engine.renderStill({
      serveUrl,
      composition: "ScenePreview",
      inputProps: preview("s2", "landscape"),
      format: "landscape",
      frame: stillFrames(35)[0] as number,
      out,
    });
    expect(pngSize(out)).toEqual({ width: 1920, height: 1080 });
    expect(qaEntries(logs).filter((e) => e.kind === "text_overflow")).toEqual([]);
  });

  it("renderStill: runtime-помилка сцени в ScenePreview → RenderError з логами", async () => {
    const run = engine.renderStill({
      serveUrl,
      composition: "ScenePreview",
      inputProps: preview("s4", "vertical"),
      format: "vertical",
      frame: 10,
      out: path.join(tmp, "broken.png"),
    });
    await expect(run).rejects.toBeInstanceOf(RenderError);
    await expect(run).rejects.toThrow(/зламана сцена s4/);
  });

  it("Main: впала сцена замінюється шаблоном (рендер не падає)", async () => {
    const out = path.join(OUT, "main-broken-fallback.png");
    const sb = shortStoryboard([{ id: "s4", purpose: "proof" }]);
    const { logs } = await engine.renderStill({
      serveUrl,
      composition: "Main",
      inputProps: fixtureMainProps(job, sb, "vertical", { templateScenes: [] }),
      format: "vertical",
      frame: 20,
      out,
    });
    expect(existsSync(out)).toBe(true);
    expect(logs.some((l) => l.text.includes("ADC_SCENE_ERROR"))).toBe(true);
  });

  describe("TemplateScene: 4 варіанти × 3 формати", () => {
    for (const variant of TEMPLATE_VARIANTS) {
      for (const format of FORMATS) {
        it(`${variant} / ${format}`, async () => {
          const purpose = PURPOSE_FOR[variant];
          const sb = shortStoryboard([
            {
              id: "s1",
              purpose,
              durationFrames: 90,
              text:
                variant === "cta"
                  ? { headline: "Чекаємо на каву", sub: "Львів, вул. Руська, 1", emphasis: [] }
                  : variant === "text"
                    ? {
                        headline: "Капучино — 75 грн",
                        sub: "-10% на каву з собою до 10:00",
                        emphasis: ["75 грн", "-10%"],
                      }
                    : {
                        headline: "Кава, яку обсмажуємо самі",
                        sub: "Щотижня свіже зерно",
                        emphasis: ["самі"],
                      },
            },
          ]);
          const out = path.join(OUT, `template-${variant}-${format}.png`);
          const { logs } = await engine.renderStill({
            serveUrl,
            composition: "ScenePreview",
            inputProps: { ...preview("s1", format), storyboard: sb, useTemplate: true },
            format,
            frame: stillFrames(90)[0] as number,
            out,
          });
          expect(pngSize(out)).toEqual(FORMAT_SIZE[format]);
          expect(logs.filter((l) => l.type === "error")).toEqual([]);
          // Шаблони на фікстурному бренді не мають програмних зауважень.
          expect(qaEntries(logs)).toEqual([]);
        });
      }
    }
  });
});
