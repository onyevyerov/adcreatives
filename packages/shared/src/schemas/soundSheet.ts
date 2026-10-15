import { z } from "zod";
import { SoundAccent, SoundCue, type Storyboard } from "./storyboard.ts";

export const SoundSheetEvent = z.object({
  sceneId: z.string(),
  eventId: z.string(),
  cue: SoundCue,
  accent: SoundAccent,
  /** Глобальний кадр і мс якоря події (після зсуву під сітку). */
  frame: z.number().int(),
  ms: z.number(),
  /** Індекс долі і зсув якоря до найближчої долі, мс (null — доля не визначена). */
  beatIndex: z.number().int().nullable(),
  beatOffsetMs: z.number().nullable(),
  /** Пік семпла в міксі після gain, dBFS; null — подія не звучить. */
  peakDb: z.number().nullable(),
  ducked: z.boolean(),
  /** none — звучить; no_sample / decode_failed / muted — чому ні. */
  silent: z.enum(["none", "no_sample", "decode_failed", "muted"]),
});
export type SoundSheetEvent = z.infer<typeof SoundSheetEvent>;

/** Відомість звуку, яку пише зведення; єдине, що рецензент «чує». */
export const SoundSheet = z.object({
  version: z.literal(1),
  fps: z.number().int(),
  bpm: z.number(),
  totalFrames: z.number().int(),
  beatShiftMs: z.number().nullable(),
  beatConfidence: z.number().nullable(),
  barOffsetMs: z.number().nullable(),
  sceneStarts: z.array(
    z.object({
      sceneId: z.string(),
      frame: z.number().int(),
      beatOffsetMs: z.number().nullable(),
      onBar: z.boolean().nullable(),
    }),
  ),
  sections: z.array(
    z.object({
      sceneId: z.string(),
      mix: z.enum(["filtered", "full", "breakdown"]),
      fromFrame: z.number().int(),
      toFrame: z.number().int(),
    }),
  ),
  events: z.array(SoundSheetEvent),
  /** RMS зведення по секундах, dBFS. */
  rmsPerSecondDb: z.array(z.number()),
  integratedLufs: z.number().nullable(),
  truePeakDbtp: z.number().nullable(),
});
export type SoundSheet = z.infer<typeof SoundSheet>;

const n = (v: number | null, digits = 1): string => (v === null ? "—" : v.toFixed(digits));

/** Максимум символів тексту відомості для промпта (30 с ролика). */
export const SOUND_SHEET_MAX_CHARS = 6000;

/**
 * Текст відомості для промпта (таблиці, без JSON): детермінований, ≤ 6 000 символів.
 * Події йдуть у порядку сцен розкадровки, далі за кадром; сцени, яких немає в розкадровці, — в кінці.
 */
export function formatSoundSheet(sheet: SoundSheet, storyboard: Pick<Storyboard, "scenes">): string {
  const order = new Map(storyboard.scenes.map((s, i) => [s.id, i]));
  const rank = (id: string): number => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const lines: string[] = [];
  lines.push(
    `fps ${sheet.fps} · bpm ${n(sheet.bpm)} · frames ${sheet.totalFrames} · beat shift ${n(sheet.beatShiftMs)} ms` +
      ` · beat confidence ${n(sheet.beatConfidence, 2)} · bar offset ${n(sheet.barOffsetMs)} ms` +
      ` · ${n(sheet.integratedLufs)} LUFS · ${n(sheet.truePeakDbtp)} dBTP`,
  );
  lines.push("", "scene starts: scene | frame | offset to beat ms | on bar");
  const starts = [...sheet.sceneStarts].sort(
    (a, b) => rank(a.sceneId) - rank(b.sceneId) || a.frame - b.frame,
  );
  for (const s of starts) {
    const bar = s.onBar === null ? "—" : s.onBar ? "yes" : "no";
    lines.push(`${s.sceneId} | ${s.frame} | ${n(s.beatOffsetMs)} | ${bar}`);
  }
  lines.push("", "music mix: scene | mix | frames");
  for (const s of [...sheet.sections].sort((a, b) => a.fromFrame - b.fromFrame)) {
    lines.push(`${s.sceneId} | ${s.mix} | ${s.fromFrame}-${s.toFrame}`);
  }
  lines.push(
    "",
    "events: scene | event | cue/accent | frame | offset to beat ms | peak dBFS | ducked | silent",
  );
  const events = [...sheet.events].sort(
    (a, b) => rank(a.sceneId) - rank(b.sceneId) || a.frame - b.frame || a.eventId.localeCompare(b.eventId),
  );
  for (const e of events) {
    lines.push(
      `${e.sceneId} | ${e.eventId} | ${e.cue}/${e.accent} | ${e.frame} | ${n(e.beatOffsetMs)} | ${n(e.peakDb)} | ${e.ducked ? "yes" : "no"} | ${e.silent}`,
    );
  }
  lines.push("", `rms per second dBFS: ${sheet.rmsPerSecondDb.map((v) => n(v, 0)).join(" ")}`);
  const text = lines.join("\n");
  return text.length <= SOUND_SHEET_MAX_CHARS ? text : `${text.slice(0, SOUND_SHEET_MAX_CHARS - 1)}…`;
}
