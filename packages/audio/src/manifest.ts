import { type AudioManifest, computeTimeline, msToFrames, type Storyboard } from "@adc/shared";
import {
  MUSIC_FADE_OUT_MS,
  MUSIC_VOLUME,
  PUBLIC_MUSIC_FILE,
  publicSfxFile,
  SFX_VOLUME,
} from "./constants.ts";

export interface ManifestInput {
  storyboard: Pick<Storyboard, "fps" | "scenes">;
  music: { planHash: string; durationMs: number } | null;
  /** Бібліотека SFX ревізії: cue → тривалість. */
  sfx: Array<{ cue: string; durationMs: number }>;
}

/** `rev/<n>/audio.json`: музика + бібліотека SFX; шляхи — відносно `video/public/`. */
export function buildAudioManifest(input: ManifestInput): AudioManifest {
  const timeline = computeTimeline(input.storyboard);
  return {
    music: input.music
      ? {
          src: PUBLIC_MUSIC_FILE,
          durationMs: input.music.durationMs,
          fadeOutMs: MUSIC_FADE_OUT_MS,
          volume: MUSIC_VOLUME,
          planHash: input.music.planHash,
        }
      : null,
    sfx: input.sfx.map((s) => ({
      cue: s.cue,
      src: publicSfxFile(s.cue),
      durationMs: s.durationMs,
      volume: SFX_VOLUME,
    })),
    totalFrames: timeline.totalFrames,
  };
}

export interface AudioPlacement {
  kind: "music" | "sfx";
  /** cue для SFX, "music" для музики. */
  cue: string;
  sceneId: string | null;
  src: string;
  /** Глобальний кадр старту. */
  from: number;
  durationInFrames: number;
  volume: number;
  /** Лише для музики: кадри fade-out наприкінці ролика. */
  fadeOutFrames?: number;
}

/**
 * Розміщення звуку на таймлайні (те, що робить хост за `scene.sfxCue`), як чиста функція:
 * музика з кадру 0 до кінця ролика з fade-out (трек довший і підрізається);
 * SFX — на початку послідовності сцени (тобто на початку переходу), `riser` — так, щоб
 * закінчитись на цій межі. Cue без файлу в маніфесті пропускаються.
 */
export function computeAudioPlacements(
  storyboard: Pick<Storyboard, "fps" | "scenes">,
  manifest: AudioManifest,
): AudioPlacement[] {
  const timeline = computeTimeline(storyboard);
  const fps = timeline.fps;
  const out: AudioPlacement[] = [];
  if (manifest.music) {
    out.push({
      kind: "music",
      cue: "music",
      sceneId: null,
      src: manifest.music.src,
      from: 0,
      durationInFrames: Math.min(
        timeline.totalFrames,
        Math.max(1, msToFrames(manifest.music.durationMs, fps)),
      ),
      volume: manifest.music.volume,
      fadeOutFrames: Math.min(timeline.totalFrames, msToFrames(manifest.music.fadeOutMs, fps)),
    });
  }
  const lib = new Map(manifest.sfx.map((s) => [s.cue, s]));
  timeline.scenes.forEach((ts, i) => {
    const cue = storyboard.scenes[i]?.sfxCue;
    const sfx = cue ? lib.get(cue) : undefined;
    if (!cue || !sfx) return;
    const len = Math.max(1, Math.ceil((sfx.durationMs / 1000) * fps));
    const from = cue === "riser" ? Math.max(0, ts.from - len) : ts.from;
    out.push({
      kind: "sfx",
      cue,
      sceneId: ts.id,
      src: sfx.src,
      from,
      durationInFrames: Math.max(1, Math.min(len, timeline.totalFrames - from)),
      volume: sfx.volume,
    });
  });
  return out;
}
