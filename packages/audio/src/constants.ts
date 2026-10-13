import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { findRepoRoot } from "@adc/shared";

/** Параметри ElevenLabs і аудіо-маніфесту, зашиті в одному місці. */

export const MUSIC_MODEL_ID = "music_v2_5";
export const SFX_MODEL_ID = "eleven_text_to_sound_v2";

/**
 * Формати відповіді ElevenLabs, які вміє пайплайн: mp3 128/192 кбіт/с і PCM 16 біт 44.1 кГц
 * (PCM загортається у WAV одразу після отримання). 192 кбіт/с потребує тарифу Creator, PCM — Pro.
 */
export const OUTPUT_FORMATS = ["mp3_44100_128", "mp3_44100_192", "pcm_44100"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
/** Дефолт: верх треку не зрізається на ~16 кГц, як у `mp3_44100_128`. */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "mp3_44100_192";
/** Фолбек, якщо формат недоступний на тарифі (`format_not_allowed`): є на будь-якому тарифі. */
export const FORMAT_FALLBACK: OutputFormat = "mp3_44100_128";

export const MUSIC_FORMAT_ENV = "ELEVENLABS_MUSIC_FORMAT";
export const SFX_FORMAT_ENV = "ELEVENLABS_SFX_FORMAT";

export class OutputFormatError extends Error {
  override name = "OutputFormatError";
}

/**
 * Формат з env: порожньо чи немає — дефолт; невалідне значення — `OutputFormatError`
 * (процес падає на старті, а не генерує в тихому дефолті).
 */
export function readOutputFormat(
  name: string,
  env: Record<string, string | undefined> = process.env,
): OutputFormat {
  const value = env[name]?.trim();
  if (!value) return DEFAULT_OUTPUT_FORMAT;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new OutputFormatError(`${name}=${value}: допустимі ${OUTPUT_FORMATS.join(", ")}`);
}

/**
 * Середовище процесу поверх кореневого `.env` (як `loadRootEnv`: наявні змінні не перезаписуються).
 * Модуль вантажиться імпортом раніше, ніж воркер чи CLI викликають `loadRootEnv()`, тож `.env`
 * читаємо самі, не змінюючи `process.env`.
 */
function envWithRootFile(): Record<string, string | undefined> {
  let file: string;
  try {
    file = readFileSync(path.join(findRepoRoot(), ".env"), "utf8");
  } catch {
    return process.env;
  }
  return { ...parseEnv(file), ...process.env };
}

/**
 * Формати читаються один раз при завантаженні модуля: формат музики входить у `planHash`, SFX —
 * у `sfxHash`, тож протягом життя процесу вони не змінюються.
 */
const startupEnv = envWithRootFile();
export const MUSIC_OUTPUT_FORMAT: OutputFormat = readOutputFormat(MUSIC_FORMAT_ENV, startupEnv);
export const SFX_OUTPUT_FORMAT: OutputFormat = readOutputFormat(SFX_FORMAT_ENV, startupEnv);
/** PCM приходить без заголовка — у сховищі він лежить як WAV, розширення файлу — за вмістом. */
export const isPcmFormat = (format: string) => format.startsWith("pcm_");
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
/**
 * Публічне ім'я треку за ключем у сховищі: сирий `music.mp3` (декодування не вдалося або старий
 * трек) лишається `.mp3`, щоб розширення відповідало вмісту.
 */
export const publicMusicFile = (key: string) => (key.endsWith(".mp3") ? "music.mp3" : PUBLIC_MUSIC_FILE);
/** Готове зведення (музика + події + дакінг + мастер); при ньому хост не грає music і sfx. */
export const PUBLIC_MIX_FILE = "soundtrack.wav";
/** Публічне ім'я SFX; розширення — як у файлу в кеші (`key`): `.wav` для PCM, інакше `.mp3`. */
export const publicSfxFile = (cue: string, key?: string) =>
  `sfx/${cue.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}.${key?.endsWith(".wav") ? "wav" : "mp3"}`;
