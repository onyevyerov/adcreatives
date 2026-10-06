/**
 * Smoke: 2-секундний ролик із TemplateScene (hero → cta, перехід fade, музика і SFX).
 * `pnpm smoke` (корінь) → друкує шлях до mp4.
 */
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeTimeline } from "@adc/shared/timeline";
import { createRenderEngine } from "../src/engine.ts";
import { createFixtureJob, fixtureMainProps, shortStoryboard } from "../src/testing.ts";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
const out = path.join(outDir, "smoke.mp4");

const tmp = await mkdtemp(path.join(os.tmpdir(), "adc-smoke-"));
const engine = createRenderEngine();
try {
  const job = await createFixtureJob({ jobDir: path.join(tmp, "video") });
  const storyboard = shortStoryboard([
    { id: "s1", purpose: "hook" },
    { id: "s2", purpose: "cta", text: { headline: "Забронюйте столик", sub: null, emphasis: [] } },
  ]);
  const timeline = computeTimeline(storyboard);
  const props = fixtureMainProps(
    { ...job, audio: { ...job.audio, totalFrames: timeline.totalFrames } },
    storyboard,
    "vertical",
  );

  const t0 = Date.now();
  const { serveUrl } = await engine.bundleJob({ jobDir: job.jobDir });
  const bundleMs = Date.now() - t0;
  await mkdir(outDir, { recursive: true });
  const { durationMs } = await engine.renderMedia({ serveUrl, inputProps: props, format: "vertical", out });
  const { size } = await stat(out);
  console.log(
    `smoke: ${timeline.totalFrames} кадрів (${timeline.durationSeconds} с), бандл ${bundleMs} мс, рендер ${durationMs} мс, ${size} байт`,
  );
  console.log(out);
} finally {
  await engine.close();
  await rm(tmp, { recursive: true, force: true });
}
