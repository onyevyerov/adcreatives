import {
  buildStripSheet,
  collectAutoIssues,
  currentVersion,
  directorPaths,
  STRIP_STEP,
  type StripCell,
  stripLegend,
  toQaJpeg,
  versionStripSheet,
} from "@adc/director";
import {
  type AgentTool,
  type AutoIssue,
  type BrowserLog,
  Format,
  type ImageInput,
  stillFrames,
  stripFrames,
} from "@adc/shared";
import { z } from "zod";
import {
  type AuthorSession,
  authorFrameKey,
  ensureBundle,
  errorText,
  inPool,
  recordRenders,
  renderFrame,
  sceneOf,
  unrenderableReason,
} from "../session.ts";

/** Скільки кадрів рендериться одночасно (браузер спільний, сторінки окремі) — як у check. */
export const RENDER_CONCURRENCY = 3;
/** Максимум кадрів `render_frames` за виклик. */
export const MAX_FRAMES = 6;
/** Частки тривалості сцени для `contact_sheet`. */
export const CONTACT_FRACTIONS = [0.15, 0.4, 0.65, 0.9] as const;

const FormatInput = Format.optional().describe(
  "Format to render; default: the first format the client chose.",
);

const sec = (frame: number, fps: number) => (frame / fps).toFixed(1);

function formatOf(session: AuthorSession, format: Format | undefined): Format {
  return format ?? (session.formats[0] as Format);
}

function issueLines(issues: readonly AutoIssue[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of issues) {
    const key = `${i.kind}|${i.component}|${i.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`- frame ${i.frame ?? "?"}: ${i.kind} (${i.component}): ${i.detail}`);
  }
  return out;
}

interface FrameResult {
  frame: number;
  png: Buffer | null;
  logs: BrowserLog[];
  error: string | null;
}

/** Рендерить кадри однієї сцени в один формат; помилка кадру — у результаті, не виняток. */
async function renderFrames(
  session: AuthorSession,
  bundle: Awaited<ReturnType<typeof ensureBundle>>,
  sceneId: string,
  format: Format,
  frames: readonly number[],
): Promise<FrameResult[]> {
  const { storage } = session.ctx;
  const results = new Map<number, FrameResult>();
  await inPool(frames, RENDER_CONCURRENCY, async (frame) => {
    const key = authorFrameKey(session, format, sceneId, frame);
    try {
      const logs = await renderFrame(session, bundle, sceneId, format, frame, key);
      results.set(frame, { frame, png: await storage.read(key), logs, error: null });
    } catch (err) {
      if (session.ctx.signal?.aborted) throw err;
      const logs = (err as { logs?: BrowserLog[] } | null)?.logs ?? [];
      results.set(frame, { frame, png: null, logs, error: errorText(err) });
    }
  });
  return frames.map((f) => results.get(f) as FrameResult);
}

/** Бандл або текст помилки збирання для моделі. */
async function bundleOrError(
  session: AuthorSession,
): Promise<{ bundle: Awaited<ReturnType<typeof ensureBundle>> } | { text: string }> {
  try {
    return { bundle: await ensureBundle(session) };
  } catch (err) {
    if (session.ctx.signal?.aborted) throw err;
    return { text: `error: the video project did not bundle:\n${errorText(err)}` };
  }
}

const StripInput = z.object({ sceneId: z.string(), format: FormatInput });

/**
 * `render_strip` — кадри сцени кожні 0.5 с (`stripFrames(d, STRIP_STEP)`) одним аркушем, як його бачить
 * арт-директор, плюс авто-перевірки компонентів (`ADC_QA`) і помилки рендера текстом. Аркуш
 * зберігається як аркуш стрічки поточної версії сцени (`versionStripSheet`).
 */
export function renderStripTool(session: AuthorSession): AgentTool<z.infer<typeof StripInput>> {
  return {
    name: "render_strip",
    description:
      "Render one scene every 0.5 s as a single contact sheet (the way the art director sees it) and list the " +
      "automatic layout checks of the components (text that did not fit, elements outside the safe area, low " +
      "contrast) and render errors. Use it after write_scene to look at what you built.",
    input: StripInput,
    async run({ sceneId, format: f }) {
      const format = formatOf(session, f);
      const scene = sceneOf(session, sceneId);
      const res = await bundleOrError(session);
      if ("text" in res) return res;
      const reason = unrenderableReason(session, res.bundle.job, sceneId);
      if (reason || !scene) return { text: `error: ${reason}` };
      const { fps } = session.storyboard;
      const frames = stripFrames(scene.durationFrames, STRIP_STEP);
      const results = await renderFrames(session, res.bundle, sceneId, format, frames);
      await recordRenders(session, frames.length, `author:strip:${sceneId}`);

      const cells: StripCell[] = results.map((r) => ({
        frame: r.frame,
        png: r.png,
        label: `${r.frame} · ${sec(r.frame, fps)}s`,
        note: "render error",
      }));
      const sheet = await buildStripSheet(format, cells);
      const { ctx } = session;
      const ver = currentVersion(session.ledger, sceneId);
      const sheetKey = ver
        ? versionStripSheet(ctx.projectId, ctx.rev, sceneId, ver.v, format)
        : `${directorPaths(ctx.projectId, ctx.rev).root}/author/strips/${format}/${sceneId}.jpg`;
      await ctx.storage.write(sheetKey, sheet);
      session.artifacts.add(sheetKey);

      const issues = results.flatMap((r) => collectAutoIssues(r.logs, sceneId, format, r.frame));
      const errors = results.filter((r) => r.error !== null);
      const lines = [stripLegend(sceneId, format, scene.durationFrames, fps)];
      if (scene.events.length) {
        lines.push(
          `events: ${scene.events.map((e) => `${e.id} @ frame ${e.at} (${sec(e.at, fps)}s)${e.sound ? ` ${e.sound.cue}` : ""}`).join("; ")}`,
        );
      }
      lines.push(
        errors.length
          ? `render errors on ${errors.length} frame(s); first at frame ${errors[0]?.frame}: ${errors[0]?.error}`
          : "render errors: none.",
      );
      const issueText = issueLines(issues);
      lines.push(
        issueText.length
          ? `automatic checks (frames where arrivals are still running may report transient issues):\n${issueText.join("\n")}`
          : "automatic checks: none.",
      );
      return { text: lines.join("\n"), images: [{ mediaType: "image/jpeg", data: sheet }] };
    },
  };
}

const FramesInput = z.object({
  sceneId: z.string(),
  frames: z
    .array(z.number().int().min(0))
    .min(1)
    .max(MAX_FRAMES)
    .describe(`Local frames of the scene (0 = its first frame), at most ${MAX_FRAMES}.`),
  format: FormatInput,
});

/** `render_frames` — до 6 окремих кадрів сцени у повному розмірі (JPEG ≤ 1568 px) для детального погляду. */
export function renderFramesTool(session: AuthorSession): AgentTool<z.infer<typeof FramesInput>> {
  return {
    name: "render_frames",
    description:
      `Render up to ${MAX_FRAMES} chosen frames of one scene as separate full-size images, to inspect details ` +
      "(an event's exact frame, small text, a join with the next scene).",
    input: FramesInput,
    async run({ sceneId, frames: wanted, format: f }) {
      const format = formatOf(session, f);
      const scene = sceneOf(session, sceneId);
      const res = await bundleOrError(session);
      if ("text" in res) return res;
      const reason = unrenderableReason(session, res.bundle.job, sceneId);
      if (reason || !scene) return { text: `error: ${reason}` };
      const last = scene.durationFrames - 1;
      const frames = [...new Set(wanted.map((x) => Math.min(last, x)))].sort((a, b) => a - b);
      const results = await renderFrames(session, res.bundle, sceneId, format, frames);
      await recordRenders(session, frames.length, `author:frames:${sceneId}`);
      const images: ImageInput[] = [];
      const lines = [`scene ${sceneId}, format ${format}, frames in this order:`];
      for (const r of results) {
        if (r.png) images.push(await toQaJpeg(r.png));
        const issues = issueLines(collectAutoIssues(r.logs, sceneId, format, r.frame));
        lines.push(
          `- frame ${r.frame} (${sec(r.frame, session.storyboard.fps)}s): ${
            r.error ? `render error: ${r.error}` : issues.length ? `checks:\n  ${issues.join("\n  ")}` : "ok"
          }`,
        );
      }
      return { text: lines.join("\n"), images };
    },
  };
}

const SheetInput = z.object({ format: FormatInput });

/**
 * `contact_sheet` — увесь фільм одним аркушем: кожна сцена по 4 кадри (15/40/65/90 % тривалості), щоб
 * побачити єдність мови, кольорову лінію і чи не повторюють сусідні сцени макет.
 */
export function contactSheetTool(session: AuthorSession): AgentTool<z.infer<typeof SheetInput>> {
  return {
    name: "contact_sheet",
    description:
      "Render the whole film as one sheet: every scene at 15, 40, 65 and 90% of its length, in storyboard order, " +
      "to judge it as one film (one language, the colour line, no two neighbouring scenes with the same layout).",
    input: SheetInput,
    async run({ format: f }) {
      const format = formatOf(session, f);
      const res = await bundleOrError(session);
      if ("text" in res) return res;
      const { fps } = session.storyboard;
      const cells: StripCell[] = [];
      const skipped: string[] = [];
      let renders = 0;
      for (const scene of session.storyboard.scenes) {
        const reason = unrenderableReason(session, res.bundle.job, scene.id);
        const frames = stillFrames(scene.durationFrames, CONTACT_FRACTIONS);
        if (reason) {
          skipped.push(reason);
          for (const frame of frames)
            cells.push({ frame, png: null, label: `${scene.id} · —`, note: "no code" });
          continue;
        }
        const results = await renderFrames(session, res.bundle, scene.id, format, frames);
        renders += frames.length;
        for (const r of results) {
          cells.push({
            frame: r.frame,
            png: r.png,
            label: `${scene.id} · ${sec(r.frame, fps)}s`,
            note: "render error",
          });
        }
      }
      await recordRenders(session, renders, "author:contact");
      const sheet = await buildStripSheet(format, cells);
      const key = `${directorPaths(session.ctx.projectId, session.ctx.rev).root}/author/contact-${format}.jpg`;
      await session.ctx.storage.write(key, sheet);
      session.artifacts.add(key);
      const text = [
        `film ${format}: ${session.storyboard.scenes.length} scenes × ${CONTACT_FRACTIONS.length} frames, ` +
          "left to right, top to bottom; label = scene · seconds from the scene start.",
        ...(skipped.length ? ["not rendered:", ...skipped.map((s) => `- ${s}`)] : []),
      ].join("\n");
      return { text, images: [{ mediaType: "image/jpeg", data: sheet }] };
    },
  };
}
