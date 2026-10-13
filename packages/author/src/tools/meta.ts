import { currentVersion, rejectedScenes } from "@adc/director";
import {
  type AgentTool,
  AudioManifest,
  computeEventPlacements,
  computeTimeline,
  MusicMeta,
  type MusicTrackCheck,
  projectPaths,
  type Storage,
  type Storyboard,
} from "@adc/shared";
import { z } from "zod";
import { type AuthorSession, brokenScenes } from "../session.ts";

const sec = (frame: number, fps: number) => (frame / fps).toFixed(2);

/** Таблиця подій зі звуком: сцена, id, локальний кадр, секунда фільму, cue й акцент, що відбувається. */
export function audioEventsTable(storyboard: Storyboard): string {
  const { fps } = storyboard;
  const timeline = computeTimeline(storyboard);
  const lines = [
    `fps ${fps}, film ${sec(timeline.totalFrames, fps)} s` +
      (storyboard.musicBrief?.bpm ? `, music ${storyboard.musicBrief.bpm} bpm` : ""),
    "scene | event | scene frame | film time | sound | what",
  ];
  for (const p of computeEventPlacements(storyboard)) {
    const ts = timeline.scenes.find((s) => s.id === p.sceneId);
    const scene = storyboard.scenes.find((s) => s.id === p.sceneId);
    const what = scene?.events.find((e) => e.id === p.eventId)?.what ?? "scene arrives (legacy sfxCue)";
    const local = p.frame - (ts?.from ?? 0);
    const sound = p.cue ? `${p.cue}${p.accent !== "normal" ? ` (${p.accent})` : ""}` : "—";
    lines.push(`${p.sceneId} | ${p.eventId} | ${local} | ${sec(p.frame, fps)} s | ${sound} | ${what}`);
  }
  for (const ts of timeline.scenes) {
    lines.push(
      `scene ${ts.id}: film frames ${ts.from}–${ts.end - 1} (${sec(ts.from, fps)}–${sec(ts.end, fps)} s)`,
    );
  }
  return lines.join("\n");
}

/** Що відомо про трек ревізії на момент виклику (гілка звуку йде паралельно — може ще не бути). */
export interface AudioTrackInfo {
  /** Темп: з перевірки треку, інакше з музичного брифу розкадровки. */
  bpm: number | null;
  /** Тональність плану звуку (`audio-plan.json`). */
  keyPlanned: string | null;
  /** Перевірка треку (`music.json`); null — трек ще не готовий або не перевірявся. */
  check: MusicTrackCheck | null;
  /** Мастер зведення (`audio.json`); null — зведення ще немає або воно старе. */
  mix: { integratedLufs: number | null; truePeakDbtp: number | null } | null;
}

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;
const fx = (v: number | null | undefined, digits: number) =>
  typeof v === "number" ? v.toFixed(digits) : "?";

/** Ширина стерео словами за кореляцією L/R: 1 — моно, 0 — незалежні канали. */
const widthWord = (corr: number) => (corr >= 0.95 ? "almost mono" : corr >= 0.6 ? "moderate" : "wide");

/** Заголовок `audio_events`: чим грає фільм — темп, тональності плану й треку, гучність, долі й такти, ширина. */
export function audioTrackHeader(info: AudioTrackInfo): string {
  const { check } = info;
  const detected = check?.keyDetected
    ? `${NOTE_NAMES[check.keyDetected.root] ?? "?"} ${check.keyDetected.minor ? "minor" : "major"} ` +
      `(confidence ${fx(check.keyDetected.confidence, 2)})`
    : "unknown";
  const lines = [
    `track: ${info.bpm ? `${info.bpm} bpm` : "tempo unknown"}, key planned ${info.keyPlanned ?? "none"}, ` +
      `detected in the track ${detected}`,
  ];
  if (!check) {
    lines.push(
      "track check: not available yet (music is generated in parallel); sound times below still hold",
    );
  } else {
    const width =
      typeof check.stereoCorrelation === "number"
        ? `${widthWord(check.stereoCorrelation)} (L/R correlation ${fx(check.stereoCorrelation, 2)}, ` +
          `below 150 Hz ${fx(check.lowCorrelation, 2)}; 1 = mono)`
        : "unknown";
    lines.push(
      `track check: ${check.ok ? "ok" : "FAILED"}, beat confidence ${fx(check.beatConfidence, 2)}, ` +
        `bar (downbeat) confidence ${fx(check.barConfidence, 2)}, raw loudness ${fx(check.integratedLufs, 1)} LUFS, ` +
        `stereo width ${width}`,
    );
  }
  lines.push(
    info.mix && info.mix.integratedLufs !== null
      ? `mix: ${fx(info.mix.integratedLufs, 1)} LUFS, true peak ${fx(info.mix.truePeakDbtp, 1)} dBTP`
      : "mix: not built yet",
  );
  return lines.join("\n");
}

async function readJsonOrNull<T>(storage: Storage, key: string, parse: (v: unknown) => T): Promise<T | null> {
  try {
    if (!(await storage.exists(key))) return null;
    return await storage.readJson(key, parse);
  } catch {
    return null;
  }
}

/**
 * Трек ревізії зі сховища: `audio-plan.json` (тональність), `audio.json` (мастер і `planHash`),
 * `audio/<planHash>/music.json` (перевірка). Чого ще немає — null, без помилки.
 */
export async function readAudioTrackInfo(
  storage: Storage,
  projectId: string,
  rev: number,
  storyboard: Storyboard,
): Promise<AudioTrackInfo> {
  const paths = projectPaths(projectId);
  const plan = await readJsonOrNull(storage, paths.rev(rev).audioPlan, (v) => v as { key?: unknown });
  const manifest = await readJsonOrNull(storage, paths.rev(rev).audio, (v) => AudioManifest.parse(v));
  const planHash = manifest?.music?.planHash ?? null;
  const meta = planHash
    ? await readJsonOrNull(storage, paths.musicMeta(planHash), (v) => MusicMeta.parse(v))
    : null;
  const check = meta?.check ?? null;
  return {
    bpm: check?.bpm ?? storyboard.musicBrief?.bpm ?? null,
    keyPlanned: typeof plan?.key === "string" ? plan.key : null,
    check,
    mix: manifest?.mix
      ? { integratedLufs: manifest.mix.integratedLufs, truePeakDbtp: manifest.mix.truePeakDbtp }
      : null,
  };
}

const Empty = z.object({});

/** `audio_events` — read-only: трек (темп, тональність, гучність, ширина) і моменти зі звуком у секундах фільму. */
export function audioEventsTool(session: AuthorSession): AgentTool<z.infer<typeof Empty>> {
  return {
    name: "audio_events",
    description:
      "Describe the music track (tempo, planned and detected key, loudness, beat and bar confidence, stereo width) " +
      "and list every event of the film with its sound: scene, event id, frame within the scene, time in the film, " +
      "cue and what happens. The soundtrack is built from these frames; read-only.",
    input: Empty,
    async run() {
      const { storage, projectId, rev } = session.ctx;
      const info = await readAudioTrackInfo(storage, projectId, rev, session.storyboard);
      const header = audioTrackHeader(info);
      return { text: `${header}\n${audioEventsTable(session.storyboard)}` };
    },
  };
}

/** Цілі, у яких немає коду, що пройшов guard і компілюється. */
export function unfinishedTargets(session: AuthorSession): string[] {
  const rejected = new Set([...rejectedScenes(session.ledger), ...brokenScenes(session)]);
  return session.targets.filter((id) => {
    if (session.templates.has(id)) return false;
    const ver = currentVersion(session.ledger, id);
    return !ver || ver.missing || rejected.has(id);
  });
}

const FinishInput = z.object({
  summary: z.string().describe("One or two sentences in Ukrainian: what the film does and what you checked."),
});

/**
 * `finish` — завершення. Якщо в цільових сцен немає робочого коду, перший виклик повертає
 * попередження (модель може доробити), повторний — завершує однаково.
 */
export function finishTool(session: AuthorSession): AgentTool<z.infer<typeof FinishInput>> {
  let warned = false;
  return {
    name: "finish",
    description:
      "Finish the work when every scene you own has code that passes the guard and compiles, and you have looked " +
      "at it. After this call, end your turn with one short line and no more tool calls.",
    input: FinishInput,
    async run({ summary }) {
      const open = unfinishedTargets(session);
      if (open.length > 0 && !warned) {
        warned = true;
        return {
          text:
            `not finished: ${open.join(", ")} have no code that passes the guard and compiles. ` +
            "Fix them with write_scene, or call finish again to stop anyway (they will be repaired later without you).",
        };
      }
      session.finished = { summary };
      return { text: "Finished. End your turn now with one short line; do not call any more tools." };
    },
  };
}
