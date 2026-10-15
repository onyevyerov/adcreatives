import type { ClaimKind, FactKind, Format, Language, StageName } from "@adc/shared";

/** Назви стадій простими словами — для повідомлень про помилки. */
export const STAGE_LABEL_UK: Record<StageName, string> = {
  crawl: "сканування сайту",
  ingest: "обробка фото",
  brandkit: "бренд-кіт",
  "brandkit-patch": "правка бренд-кіта",
  storyboard: "сценарій",
  codegen: "генерація сцен",
  author: "генерація сцен",
  check: "перевірка сцен",
  fix: "виправлення сцен",
  qa: "перевірка якості",
  sfx: "звукові ефекти",
  review: "рецензія ролика",
  revise: "правки",
  audio: "музика",
  render: "рендер відео",
};

export const FORMAT_LABEL: Record<Format, string> = {
  vertical: "9:16",
  square: "1:1",
  landscape: "16:9",
};

export const LANGUAGE_LABEL_UK: Record<Language, string> = {
  uk: "українська",
  en: "англійська",
};

/** Непідтверджене твердження сценарію → вид факту бренд-кіта. */
export const CLAIM_TO_FACT_KIND: Record<ClaimKind, FactKind> = {
  price: "price",
  percent: "discount",
  number: "number",
  date: "date",
  superlative: "claim",
  guarantee: "guarantee",
};

export function formatsLabel(formats: readonly Format[]): string {
  return formats.map((f) => FORMAT_LABEL[f]).join(", ");
}
