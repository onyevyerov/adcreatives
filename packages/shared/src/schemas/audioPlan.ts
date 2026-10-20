import { z } from "zod";
import { AudioProvider } from "./common.ts";

/**
 * Чанк композиції музики. Межі чанків = межі сцен за `computeTimeline`;
 * сцени коротші за 3 с зливаються з сусідніми. B5 мапить це на формат ElevenLabs.
 */
export const MusicChunk = z.object({
  label: z.string(),
  /** Музична назва секції для генератора (intro, build, peak, …); без неї текст чанка = label. */
  section: z.string().optional(),
  sceneIds: z.array(z.string()).min(1),
  /** 3 000–120 000 мс (обмеження ElevenLabs), перевіряється кодом. */
  durationMs: z.number().int().min(3000).max(120000),
  positiveStyles: z.array(z.string()),
  negativeStyles: z.array(z.string()),
  contextAdherence: z.enum(["low", "medium", "high"]),
});
export type MusicChunk = z.infer<typeof MusicChunk>;

export const SfxSpec = z.object({
  /** Стандартний cue (whoosh, …) або ключ кастомного (custom-1, …). */
  cue: z.string(),
  /** Промпт для textToSoundEffects. */
  text: z.string(),
  /** 0.5–1.5 с для кастомних. */
  durationSeconds: z.number().min(0.5).max(30),
  custom: z.boolean(),
});
export type SfxSpec = z.infer<typeof SfxSpec>;

/** AudioPlan — план стадії `audio` (`audio-plan.json`); LLM-чернетка — `AudioPlanDraft` у `@adc/audio`. */
export const AudioPlan = z.object({
  compositionPlan: z.object({
    /** Стилі з музичного брифу + "instrumental". Без назв брендів і артистів. */
    positiveGlobalStyles: z.array(z.string()),
    /** Щонайменше ["vocals", "lyrics"]. */
    negativeGlobalStyles: z.array(z.string()),
    chunks: z.array(MusicChunk).min(1),
  }),
  /** Тональність треку («A minor») — для висоти тону звукових подій; null — невідома. */
  key: z.string().nullable().default(null),
  /** Запасний промпт для music.compose. */
  promptFallback: z.string(),
  /** Стандартні cue + до 3 кастомних. */
  sfx: z.array(SfxSpec),
});
export type AudioPlan = z.infer<typeof AudioPlan>;

/** Перевірка згенерованого треку: чи є бочка на сітці і чи нема провалів. */
export const MusicTrackCheck = z.object({
  bpm: z.number(),
  kickOnsets: z.number().int(),
  beatConfidence: z.number(),
  /** Провали RMS > 1 с відносно медіани треку, мс. */
  gaps: z.array(z.object({ fromMs: z.number().int(), toMs: z.number().int(), dropDb: z.number() })),
  rmsPerSecondDb: z.array(z.number()),
  ok: z.boolean(),
  /** Тональність, визначена за треком (C = 0 … B = 11); null — не визначалась (старі треки). */
  keyDetected: z
    .object({ root: z.number().int().min(0).max(11), minor: z.boolean(), confidence: z.number() })
    .nullable()
    .default(null),
  /** Зсув першої сильної долі (downbeat) відносно сітки долей, мс; null — не визначено. */
  barOffsetMs: z.number().nullable().default(null),
  barConfidence: z.number().nullable().default(null),
  /** Кореляція L/R усього треку (−1..1) і нижче 150 Гц. */
  stereoCorrelation: z.number().nullable().default(null),
  lowCorrelation: z.number().nullable().default(null),
  /** Інтегральна гучність (ITU-R BS.1770-4) і true peak сирого треку. */
  integratedLufs: z.number().nullable().default(null),
  truePeakDbtp: z.number().nullable().default(null),
});
export type MusicTrackCheck = z.infer<typeof MusicTrackCheck>;

/** Метадані згенерованої музики: `audio/<planHash>/music.json`. */
export const MusicMeta = z.object({
  planHash: z.string(),
  durationMs: z.number().int(),
  modelId: z.string(),
  /** Звідки трек; старі `music.json` без поля — ElevenLabs. */
  provider: AudioProvider.default("elevenlabs"),
  /** catalog — трек з каталогу Epidemic. */
  method: z.enum(["composeDetailed", "compose", "catalog"]),
  /** Промпт, який реально пішов (із заміною, якщо API запропонував). */
  promptUsed: z.string().nullable(),
  briefHash: z.string(),
  createdAt: z.string(),
  /** Перевірка треку після генерації; null — не перевірявся (старі треки). */
  check: MusicTrackCheck.nullable().default(null),
  /** Скільки генерацій знадобилось (включно з першою). */
  attempts: z.number().int().min(1).default(1),
  /** Зсув вікна відео в сирому треку (кратний такту), мс; `music.wav` уже обрізаний на нього. */
  offsetMs: z.number().int().min(0).default(0),
  /** Лише provider=epidemic. */
  epidemic: z
    .object({
      trackId: z.string(),
      title: z.string(),
      artists: z.array(z.string()),
      /** Темп треку за каталогом і темп розкадровки, під який його підібрано. */
      bpm: z.number().nullable(),
      targetBpm: z.number(),
      /** Темп кандидата поза допуском ±10 — узято найближчий (попередження у звіт). */
      tempoWarning: z.boolean(),
      versionJobId: z.string().nullable(),
      /**
       * Останній статус задачі Create versions як його віддав API (`TIMEOUT` — не дочекались);
       * null — версію не запитували (кеш завантажень) або старт упав до відповіді.
       */
      versionStatus: z.string().nullable().default(null),
      /** Скільки кандидатів перевірено (1 — перший пройшов checkTrack). */
      candidatesTried: z.number().int().min(1),
    })
    .nullable()
    .default(null),
});
export type MusicMeta = z.infer<typeof MusicMeta>;
