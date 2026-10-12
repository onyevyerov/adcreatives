import { currentVersion, rejectedScenes } from "@adc/director";
import { type AgentTool, computeEventPlacements, computeTimeline, type Storyboard } from "@adc/shared";
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

const Empty = z.object({});

/** `audio_events` — read-only: моменти розкадровки зі звуком у секундах фільму. */
export function audioEventsTool(session: AuthorSession): AgentTool<z.infer<typeof Empty>> {
  return {
    name: "audio_events",
    description:
      "List every event of the film with its sound: scene, event id, frame within the scene, time in the film, " +
      "cue and what happens. The soundtrack is built from these frames; read-only.",
    input: Empty,
    async run() {
      return { text: audioEventsTable(session.storyboard) };
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
