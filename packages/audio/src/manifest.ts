import {
  type AudioManifest,
  computeSfxPlacements,
  computeTimeline,
  msToFrames,
  type Storyboard,
} from "@adc/shared";
import {
  MUSIC_FADE_OUT_MS,
  MUSIC_VOLUME,
  PUBLIC_MIX_FILE,
  PUBLIC_MUSIC_FILE,
  publicSfxFile,
  SFX_VOLUME,
} from "./constants.ts";

export interface ManifestInput {
  storyboard: Pick<Storyboard, "fps" | "scenes">;
  /** `src` — публічне ім'я треку (дефолт `PUBLIC_MUSIC_FILE`). */
  music: { planHash: string; durationMs: number; src?: string } | null;
  /** Бібліотека SFX ревізії: cue → тривалість; `key` — файл у кеші (`.wav` → публічне ім'я `.wav`). */
  sfx: Array<{ cue: string; durationMs: number; key?: string }>;
  /**
   * Готове зведення `soundtrack.wav` і заміри мастера (null — невідомо); null — зведення немає
   * (хост грає music і sfx, як раніше).
   */
  mix?: {
    durationMs: number;
    integratedLufs?: number | null;
    truePeakDbtp?: number | null;
    masterGainDb?: number | null;
  } | null;
}

/**
 * `rev/<n>/audio.json`: музика + бібліотека SFX + зведення; шляхи — відносно `video/public/`.
 * `music` лишається і при зведенні: за ним шукається трек для повторного використання.
 */
export function buildAudioManifest(input: ManifestInput): AudioManifest {
  const timeline = computeTimeline(input.storyboard);
  return {
    music: input.music
      ? {
          src: input.music.src ?? PUBLIC_MUSIC_FILE,
          durationMs: input.music.durationMs,
          fadeOutMs: MUSIC_FADE_OUT_MS,
          volume: MUSIC_VOLUME,
          planHash: input.music.planHash,
        }
      : null,
    mix: input.mix
      ? {
          src: PUBLIC_MIX_FILE,
          durationMs: input.mix.durationMs,
          integratedLufs: input.mix.integratedLufs ?? null,
          truePeakDbtp: input.mix.truePeakDbtp ?? null,
          masterGainDb: input.mix.masterGainDb ?? null,
        }
      : null,
    sfx: input.sfx.map((s) => ({
      cue: s.cue,
      src: publicSfxFile(s.cue, s.key),
      durationMs: s.durationMs,
      volume: SFX_VOLUME,
    })),
    totalFrames: timeline.totalFrames,
    providers: { music: "elevenlabs", sfx: "elevenlabs" },
    epidemic: null,
  };
}

export interface AudioPlacement {
  kind: "mix" | "music" | "sfx";
  /** cue для SFX, "music" для музики, "mix" для зведення. */
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
 * Розміщення звуку на таймлайні (те, що робить хост), як чиста функція.
 * Є зведення — лише воно, з кадру 0 на весь ролик, без власних fade і гучності.
 * Інакше (старий `audio.json`): музика з кадру 0 до кінця ролика з fade-out (трек довший
 * і підрізається); SFX — за спільним правилом `computeSfxPlacements` із `@adc/shared`.
 */
export function computeAudioPlacements(
  storyboard: Pick<Storyboard, "fps" | "scenes">,
  manifest: AudioManifest,
): AudioPlacement[] {
  const timeline = computeTimeline(storyboard);
  const fps = timeline.fps;
  if (manifest.mix) {
    return [
      {
        kind: "mix",
        cue: "mix",
        sceneId: null,
        src: manifest.mix.src,
        from: 0,
        durationInFrames: timeline.totalFrames,
        volume: 1,
      },
    ];
  }
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
  for (const p of computeSfxPlacements(storyboard, manifest.sfx)) {
    const sfx = lib.get(p.cue);
    if (!sfx) continue;
    out.push({ kind: "sfx", ...p, src: sfx.src, volume: sfx.volume });
  }
  return out;
}
