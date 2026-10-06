import { z } from "zod";

/**
 * Базові типи, спільні для всіх схем.
 *
 * Правило для схем, які йдуть у structured output (позначені «LLM-схема»):
 * - без `z.record`, `z.unknown`, `z.any`, `z.map` — SDK не вміє перетворити їх у strict JSON Schema;
 * - необов'язкові поля — через `.nullable()`, а не `.optional()` (модель завжди повертає ключ);
 * - min/max/довжини API не гарантує — SDK прибирає їх зі схеми, а перевіряє Zod після відповіді.
 */

export const FORMATS = ["vertical", "square", "landscape"] as const;
export const Format = z.enum(FORMATS);
export type Format = z.infer<typeof Format>;

export const FORMAT_SIZE: Record<Format, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
};

/** Основний формат — перший з обраних у порядку vertical, square, landscape. */
export function primaryFormat(formats: readonly Format[]): Format {
  const found = FORMATS.find((f) => formats.includes(f));
  if (!found) throw new Error("primaryFormat: список форматів порожній");
  return found;
}

/** Сортує і дедуплікує формати у канонічному порядку. */
export function normalizeFormats(formats: readonly Format[]): Format[] {
  return FORMATS.filter((f) => formats.includes(f));
}

export const Language = z.enum(["uk", "en"]);
export type Language = z.infer<typeof Language>;

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "колір у форматі #RRGGBB");
export type HexColor = z.infer<typeof HexColor>;

/** Точка фокусу в нормованих координатах 0..1. */
export const Focal = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type Focal = z.infer<typeof Focal>;

export const IsoDate = z.iso.datetime({ offset: true });

/** ID сцени: s1, s2, … — стабільний між ревізіями. */
export const SceneId = z.string().regex(/^s[0-9]{1,2}$/, "id сцени у форматі s1, s2, …");
export type SceneId = z.infer<typeof SceneId>;

/** ID асета з assets.json (напр. a01, u03). */
export const AssetId = z.string().min(1).max(32);

/** Хто ініціював прогін: живий чат, eval-скрипт чи тести/живі прогони. */
export const RunSource = z.enum(["chat", "eval", "test"]);
export type RunSource = z.infer<typeof RunSource>;

/** Стандартні SFX-cue, які кешуються раз на деплой. */
export const STANDARD_SFX_CUES = [
  "whoosh",
  "pop",
  "click",
  "impact",
  "shimmer",
  "swoosh",
  "riser",
  "tick",
] as const;
export const StandardSfxCue = z.enum(STANDARD_SFX_CUES);
export type StandardSfxCue = z.infer<typeof StandardSfxCue>;
