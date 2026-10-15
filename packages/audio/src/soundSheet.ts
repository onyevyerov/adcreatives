import {
  computeEventPlacements,
  computeTimeline,
  SoundAccent,
  SoundCue,
  type SoundSheet,
  type SoundSheetEvent,
  type Storyboard,
} from "@adc/shared";
import { z } from "zod";
import { BEATS_PER_BAR } from "./bars.ts";
import { type BeatGrid, nearestBeatIndex, type Soundtrack } from "./mixer.ts";
import { frameToSample } from "./pcm.ts";
import { rmsPerSecondDb } from "./trackCheck.ts";

/**
 * Звукова відомість (`rev/<n>/sound-sheet.json`): що й де звучить у зведенні — єдине, що рецензент
 * «чує». Будується з фактів зведення (`MixFacts`), а не перерахунком міксу; факти кешуються поруч
 * із WAV, тож той самий мікс дає побайтно ту саму відомість і з кешу, і після рендера.
 */

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

const FactEvent = z.object({
  sceneId: z.string(),
  eventId: z.string(),
  cue: SoundCue,
  accent: SoundAccent,
  /** Глобальний кадр події і семпл якоря в треку. */
  frame: z.number().int(),
  at: z.number().int(),
  beatIndex: z.number().int().nullable(),
});

/** Факти зведення для відомості: усе, що з міксу, без PCM. */
export const MixFacts = z.object({
  sampleRate: z.number().int(),
  beatShiftMs: z.number().nullable(),
  beatConfidence: z.number().nullable(),
  grid: z.object({ periodSec: z.number(), onBar: z.boolean() }).nullable(),
  sounds: z.array(FactEvent.extend({ peakDb: z.number(), ducked: z.boolean() })),
  silent: z.array(FactEvent.extend({ reason: z.enum(["no_sample", "decode_failed"]) })),
  rmsPerSecondDb: z.array(z.number()),
});
export type MixFacts = z.infer<typeof MixFacts>;

/**
 * Факти з готового зведення. `decodeFailed` — cue, у яких семпли були, але жоден не декодувався
 * (їхні події мовчать з причиною `decode_failed`, а не `no_sample`).
 */
export function mixFacts(soundtrack: Soundtrack, decodeFailed: ReadonlySet<SoundCue> = new Set()): MixFacts {
  const sr = soundtrack.pcm.sampleRate;
  const a = soundtrack.alignment;
  return {
    sampleRate: sr,
    beatShiftMs: a ? round1((a.shiftSamples / sr) * 1000) : null,
    beatConfidence: a ? round2(a.confidence) : null,
    grid: soundtrack.beatGrid
      ? { periodSec: soundtrack.beatGrid.periodSec, onBar: soundtrack.beatGrid.onBar }
      : null,
    sounds: soundtrack.sounds.map((s) => ({
      sceneId: s.sceneId,
      eventId: s.eventId,
      cue: s.cue,
      accent: s.accent,
      frame: s.frame,
      at: s.at,
      beatIndex: s.beatIndex,
      peakDb: round1(s.peakDb),
      ducked: s.ducked,
    })),
    silent: soundtrack.silent.map((p) => ({
      sceneId: p.sceneId,
      eventId: p.eventId,
      cue: p.cue,
      accent: p.accent,
      frame: p.frame,
      at: p.at,
      beatIndex: p.beatIndex,
      reason: decodeFailed.has(p.cue) ? "decode_failed" : "no_sample",
    })),
    rmsPerSecondDb: rmsPerSecondDb(soundtrack.pcm),
  };
}

export interface SoundSheetContext {
  /** Ефективна розкадровка — та, що звелась (після `applySfxPlan`). */
  storyboard: Pick<Storyboard, "fps" | "scenes" | "musicBrief">;
  /**
   * Розкадровка до плану SFX (чернетка режисера): її події зі звуком, які план вимкнув, ідуть у
   * відомість із `silent: "muted"`. null — плану не було.
   */
  draft?: Pick<Storyboard, "fps" | "scenes" | "musicBrief"> | null;
  /** Зсув першої сильної долі в сирому треку (`MusicTrackCheck.barOffsetMs`). */
  barOffsetMs: number | null;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
}

const key = (sceneId: string, eventId: string) => `${sceneId}\u0000${eventId}`;
/** Порівняння за кодовими одиницями (не залежить від локалі). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Відомість зі фактів зведення. Чиста функція: ті самі факти й контекст → той самий об'єкт. */
export function buildSoundSheet(facts: MixFacts, ctx: SoundSheetContext): SoundSheet {
  const { storyboard } = ctx;
  const fps = storyboard.fps;
  const sr = facts.sampleRate;
  const grid: BeatGrid | null = facts.grid;
  const timeline = computeTimeline(storyboard);
  const ms = (at: number) => round1((at / sr) * 1000);
  const offsetMs = (at: number, beatIndex: number | null) =>
    beatIndex === null || !grid ? null : round1((at / sr - beatIndex * grid.periodSec) * 1000);

  const events: SoundSheetEvent[] = [];
  for (const s of facts.sounds) {
    events.push({
      sceneId: s.sceneId,
      eventId: s.eventId,
      cue: s.cue,
      accent: s.accent,
      frame: s.frame,
      ms: ms(s.at),
      beatIndex: s.beatIndex,
      beatOffsetMs: offsetMs(s.at, s.beatIndex),
      peakDb: s.peakDb,
      ducked: s.ducked,
      silent: "none",
    });
  }
  for (const s of facts.silent) {
    events.push({
      sceneId: s.sceneId,
      eventId: s.eventId,
      cue: s.cue,
      accent: s.accent,
      frame: s.frame,
      ms: ms(s.at),
      beatIndex: s.beatIndex,
      beatOffsetMs: offsetMs(s.at, s.beatIndex),
      peakDb: null,
      ducked: false,
      silent: s.reason,
    });
  }
  // Вимкнені планом SFX: у чернетці звук був, у зведенні — ні.
  if (ctx.draft) {
    const effective = new Map(computeEventPlacements(storyboard).map((p) => [key(p.sceneId, p.eventId), p]));
    for (const p of computeEventPlacements(ctx.draft)) {
      if (p.cue === null || effective.get(key(p.sceneId, p.eventId))?.cue !== null) continue;
      const at = frameToSample(p.frame, fps, sr);
      const beatIndex = nearestBeatIndex(at, grid, sr);
      events.push({
        sceneId: p.sceneId,
        eventId: p.eventId,
        cue: p.cue,
        accent: p.accent,
        frame: p.frame,
        ms: ms(at),
        beatIndex,
        beatOffsetMs: offsetMs(at, beatIndex),
        peakDb: null,
        ducked: false,
        silent: "muted",
      });
    }
  }
  const order = new Map(storyboard.scenes.map((s, i) => [s.id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  events.sort((a, b) => a.frame - b.frame || rank(a.sceneId) - rank(b.sceneId) || cmp(a.eventId, b.eventId));

  const mixOf = new Map<string, SoundSheet["sections"][number]["mix"]>();
  for (const part of storyboard.musicBrief.structure) {
    for (const id of part.sceneIds) if (!mixOf.has(id)) mixOf.set(id, part.mix ?? "full");
  }

  return {
    version: 1,
    fps,
    bpm: storyboard.musicBrief.bpm,
    totalFrames: timeline.totalFrames,
    beatShiftMs: facts.beatShiftMs,
    beatConfidence: facts.beatConfidence,
    barOffsetMs: ctx.barOffsetMs,
    sceneStarts: timeline.scenes.map((ts) => {
      const at = frameToSample(ts.from, fps, sr);
      const beatIndex = nearestBeatIndex(at, grid, sr);
      return {
        sceneId: ts.id,
        frame: ts.from,
        beatOffsetMs: offsetMs(at, beatIndex),
        // Сильна доля відома лише тоді, коли трек зсунуто по такту.
        onBar: beatIndex === null || !grid?.onBar ? null : beatIndex % BEATS_PER_BAR === 0,
      };
    }),
    sections: timeline.scenes.map((ts) => ({
      sceneId: ts.id,
      mix: mixOf.get(ts.id) ?? "full",
      fromFrame: ts.from,
      toFrame: ts.end,
    })),
    events,
    rmsPerSecondDb: facts.rmsPerSecondDb,
    integratedLufs: ctx.integratedLufs,
    truePeakDbtp: ctx.truePeakDbtp,
  };
}
