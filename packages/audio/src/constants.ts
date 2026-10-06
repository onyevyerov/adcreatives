/** Параметри ElevenLabs і аудіо-маніфесту, зашиті в одному місці. */

export const MUSIC_MODEL_ID = "music_v2_5";
export const SFX_MODEL_ID = "eleven_text_to_sound_v2";
export const MUSIC_OUTPUT_FORMAT = "mp3_44100_128";
/** Таймаут генерації музики (композиція може йти кілька хвилин). */
export const MUSIC_TIMEOUT_SECONDS = 300;
export const SFX_TIMEOUT_SECONDS = 60;

/** Межі тривалості чанка композиції (обмеження ElevenLabs). */
export const MIN_CHUNK_MS = 3_000;
export const MAX_CHUNK_MS = 120_000;
/** Трек довший за відео на 1 с — хост підрізає його з fade-out. */
export const TRACK_TAIL_MS = 1_000;

/** Кастомні SFX: до 3 штук, 0.5–1.5 с, promptInfluence 0.6. */
export const MAX_CUSTOM_SFX = 3;
export const CUSTOM_SFX_MIN_SECONDS = 0.5;
export const CUSTOM_SFX_MAX_SECONDS = 1.5;
export const SFX_PROMPT_INFLUENCE = 0.6;

export const MUSIC_VOLUME = 0.8;
export const MUSIC_FADE_OUT_MS = 1_000;
export const SFX_VOLUME = 0.6;

/** Обов'язкові стилі композиції. */
export const REQUIRED_POSITIVE_STYLES = ["instrumental"] as const;
export const REQUIRED_NEGATIVE_STYLES = ["vocals", "lyrics"] as const;

/** Імена файлів у `rev/<n>/video/public/` (шляхи для staticFile()). */
export const PUBLIC_MUSIC_FILE = "music.mp3";
export const publicSfxFile = (cue: string) => `sfx/${cue.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}.mp3`;
