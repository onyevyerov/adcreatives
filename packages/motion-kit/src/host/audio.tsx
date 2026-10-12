import { msToFrames } from "@adc/shared/timeline";
import type { AudioManifest } from "@adc/shared/types/video";
import { Audio } from "@remotion/media";
import { interpolate, Sequence, staticFile, useVideoConfig } from "remotion";

/** Гучність музики з fade-out наприкінці ролика (чиста функція від кадру). */
export function musicVolumeAt(
  frame: number,
  totalFrames: number,
  fadeOutFrames: number,
  volume: number,
): number {
  const fadeStart = Math.max(0, totalFrames - Math.max(1, fadeOutFrames));
  return (
    volume *
    interpolate(frame, [fadeStart, totalFrames], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
}

/**
 * Лише для хоста: звук ролика. Є готове зведення (`audio.mix`) — грає лише його, як є:
 * музика, події, дакінг, fade-out і мастер уже всередині. Інакше (старий `audio.json`) —
 * музика з fade-out наприкінці; довший трек підрізається.
 */
export function MusicTrack(props: { audio: AudioManifest; totalFrames: number }) {
  const { fps } = useVideoConfig();
  const mix = props.audio.mix;
  if (mix) {
    return (
      <Sequence durationInFrames={props.totalFrames} name="soundtrack" layout="none">
        <Audio src={staticFile(mix.src)} trimAfter={props.totalFrames} />
      </Sequence>
    );
  }
  const music = props.audio.music;
  if (!music) return null;
  const fadeOutFrames = msToFrames(music.fadeOutMs, fps);
  return (
    <Sequence durationInFrames={props.totalFrames} name="music" layout="none">
      <Audio
        src={staticFile(music.src)}
        trimAfter={props.totalFrames}
        volume={(f) => musicVolumeAt(f, props.totalFrames, fadeOutFrames, music.volume)}
      />
    </Sequence>
  );
}

/**
 * Лише для хоста: SFX за cue з бібліотеки ревізії, з кадру `from` (глобального).
 * При зведенні (`audio.mix`) події вже в `soundtrack.wav` — нічого не грає.
 */
export function Sfx(props: { cue: string; audio: AudioManifest; from: number }) {
  const { fps } = useVideoConfig();
  if (props.audio.mix) return null;
  const sfx = props.audio.sfx.find((s) => s.cue === props.cue);
  if (!sfx) return null;
  const duration = Math.max(1, msToFrames(sfx.durationMs, fps) + 1);
  return (
    <Sequence from={props.from} durationInFrames={duration} name={`sfx:${props.cue}`} layout="none">
      <Audio src={staticFile(sfx.src)} volume={sfx.volume} />
    </Sequence>
  );
}
