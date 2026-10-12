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
/**
 * Запас довжини: трек довший за відео на 8 с. Генератор нерідко робить провал або брейк
 * усередині треку — запас дає зсунути вікно відео (кратно такту) на рівну ділянку.
 */
export const TRACK_TAIL_MS = 8_000;
/** Запас старих багаточанкових планів (до A2): трек = відео + 1 с. */
export const LEGACY_TRACK_TAIL_MS = 1_000;
/**
 * Хвіст після вікна відео в обрізаному `music.wav`: вирівнювання долі у зведенні зрізає до
 * однієї долі з початку, а останню секунду зведення гасить fade-out.
 */
export const MUSIC_WINDOW_TAIL_MS = 1_000;

/** Перевірка треку: ≥ 0.8 онсета бочки на долю у вікні відео. */
export const MIN_KICKS_PER_BEAT = 0.8;
/** Провал — ділянка довша за 1 с, тихіша за медіану RMS по секундах більш ніж на 6 дБ. */
export const GAP_MIN_MS = 1_000;
export const GAP_DROP_DB = 6;
/** Повторні генерації, якщо трек не пройшов перевірку (разом із першою — до 3 спроб). */
export const MAX_MUSIC_RETRIES = 2;

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
/** Музика — обрізаний на вікно відео WAV (`ensureMusic`); старі ревізії лишаються з `music.mp3`. */
export const PUBLIC_MUSIC_FILE = "music.wav";
/** Готове зведення (музика + події + дакінг + мастер); при ньому хост не грає music і sfx. */
export const PUBLIC_MIX_FILE = "soundtrack.wav";
export const publicSfxFile = (cue: string) => `sfx/${cue.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}.mp3`;
