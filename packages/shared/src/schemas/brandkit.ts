import { z } from "zod";
import { Focal, HexColor, IsoDate, Language } from "./common.ts";

/** Факт, на який можна посилатися в текстах сцен. */
export const FactKind = z.enum(["price", "discount", "number", "guarantee", "date", "claim"]);
export type FactKind = z.infer<typeof FactKind>;

export const Fact = z.object({
  /** f1, f2, … для фактів сайту; c1, c2, … для фактів від клієнта. */
  id: z.string(),
  kind: FactKind,
  text: z.string(),
  source: z.enum(["site", "client"]),
  /** Для фактів із сайту — сторінка, де знайдено. */
  sourceUrl: z.string().nullable(),
  /** Для фактів із сайту — дослівна цитата. */
  quote: z.string().nullable(),
});
export type Fact = z.infer<typeof Fact>;

export const Palette = z.object({
  primary: HexColor,
  secondary: HexColor,
  accent: HexColor,
  background: HexColor,
  surface: HexColor,
  textOnDark: HexColor,
  textOnLight: HexColor,
  /** Семантичні кольори; null — бренд-кіт виводить їх кодом, у Theme вони завжди є. */
  danger: HexColor.nullable().default(null),
  warning: HexColor.nullable().default(null),
  success: HexColor.nullable().default(null),
});
export type Palette = z.infer<typeof Palette>;

/** Семантичні ролі палітри (можуть бути null у бренд-кіті; у темі motion-kit — завжди колір). */
export const SEMANTIC_PALETTE_ROLES = ["danger", "warning", "success"] as const;
export type SemanticPaletteRole = (typeof SEMANTIC_PALETTE_ROLES)[number];
/** Брендові ролі палітри — завжди задані. */
export type BasePaletteRole = Exclude<keyof Palette, SemanticPaletteRole>;

/** Файл шрифту сайту в сховищі (для `origin: "local"`). */
export const FontFile = z.object({
  weight: z.number().int().min(100).max(900),
  /** Italic не підтримуємо. */
  style: z.enum(["normal"]),
  format: z.enum(["woff2", "woff", "truetype", "opentype"]),
  /** Ключ у сховищі: crawl/fonts/<fontKey>-<weight>.<ext>. */
  path: z.string(),
});
export type FontFile = z.infer<typeof FontFile>;

export const FontChoice = z.object({
  /** Назва в Google Fonts; при `origin: "local"` — назва сімейства з `@font-face` сайту (дослівно). */
  family: z.string(),
  weights: z.array(z.number().int().min(100).max(900)).min(1),
  /**
   * Звідки шрифт: виявлений на сайті і знайдений у Google Fonts, підібраний замінник
   * або файли самого сайту (не Google Fonts).
   */
  origin: z.enum(["site", "substitute", "local"]),
  /** Файли шрифту сайту; непорожній лише при `origin: "local"`. */
  files: z.array(FontFile).default([]),
});
export type FontChoice = z.infer<typeof FontChoice>;

export const Typography = z.object({
  heading: FontChoice,
  body: FontChoice,
  /** Моношрифт для чисел, eyebrow і міток; null — підбирається з fonts.json. */
  mono: FontChoice.nullable().default(null),
  /** Сімейства, виявлені на сайті як є. */
  detected: z.array(z.string()),
});
export type Typography = z.infer<typeof Typography>;

/** Речовина продукту: що він робить і як виглядає результат. Кожен рядок — дослівно з тексту сайту. */
export const ProductSubstance = z.object({
  /** Кроки роботи з продуктом у порядку: "Вставте URL", "AI сканує сайт", "Отримуєте план". */
  steps: z.array(z.object({ name: z.string(), detail: z.string().nullable() })).default([]),
  /** Що перевіряє / з чого складається: категорії, напрями, модулі. */
  checks: z.array(z.string()).default([]),
  /** Приклади результату: проблема, серйозність, оцінка, пояснення, що робити. */
  exampleIssues: z
    .array(
      z.object({
        title: z.string(),
        severity: z.enum(["critical", "moderate", "minor"]).nullable(),
        score: z.string().nullable(),
        explanation: z.string().nullable(),
        fix: z.string().nullable(),
        effort: z.string().nullable(),
      }),
    )
    .default([]),
  /** Рядки плану/списку задач з групою ("1 тиждень") і оцінкою ("3 години"). */
  planRows: z
    .array(z.object({ text: z.string(), group: z.string().nullable(), effort: z.string().nullable() }))
    .default([]),
  /** Продукти/модулі одним рядком. */
  products: z.array(z.object({ name: z.string(), oneLiner: z.string().nullable() })).default([]),
  /** Порівняння з альтернативою: критерій, ми, вони. */
  comparisons: z
    .array(z.object({ criterion: z.string(), us: z.string(), alternative: z.string() }))
    .default([]),
});
export type ProductSubstance = z.infer<typeof ProductSubstance>;

/** Порожня речовина (дефолт для старих бренд-кітів); щоразу новий об'єкт — масиви не діляться між парсами. */
export function emptySubstance(): ProductSubstance {
  return { steps: [], checks: [], exampleIssues: [], planRows: [], products: [], comparisons: [] };
}

export const LogoInfo = z.object({
  assetId: z.string().nullable(),
  type: z.enum(["image", "svg", "text"]),
  /** Лого погано читається на довільному фоні — потрібна підкладка. */
  needsBackground: z.boolean(),
  /** Текст, яким малюємо лого, якщо зображення немає. */
  textFallback: z.string(),
});
export type LogoInfo = z.infer<typeof LogoInfo>;

export const MotionPersonality = z.enum(["energetic", "calm", "premium", "playful"]);
export type MotionPersonality = z.infer<typeof MotionPersonality>;

export const AssetRole = z.enum([
  "hero",
  "product",
  "interior",
  "exterior",
  "team",
  "food",
  "detail",
  "people",
  "texture",
  "logo",
  "other",
]);

export const RankedAsset = z.object({
  assetId: z.string(),
  role: AssetRole,
  /** 1 — непридатне, 5 — відмінне. */
  quality: z.number().int().min(1).max(5),
  cropFocus: Focal,
  /** На зображенні є «запечений» текст (банер, макет) — не кропати й не накладати текст. */
  hasBakedText: z.boolean(),
  description: z.string(),
});
export type RankedAsset = z.infer<typeof RankedAsset>;

export const GapKind = z.enum([
  "few_photos",
  "no_logo",
  "no_contacts",
  "no_offer",
  "no_cta",
  "low_confidence",
  "other",
]);

export const BrandQuestion = z.object({
  id: z.string(),
  /** Тема питання: ціль, оффер, CTA тощо. */
  topic: z.enum(["goal", "offer", "cta", "audience", "other"]),
  text: z.string(),
  /** Відповідь, яку беремо, якщо клієнт промовчить. */
  default: z.string(),
  options: z.array(z.string()),
});
export type BrandQuestion = z.infer<typeof BrandQuestion>;

/**
 * BrandKit — LLM-схема (structured output стадії `brandkit`).
 * Контраст палітри і кирилиця шрифтів перевіряються й виправляються кодом після відповіді.
 */
export const BrandKit = z.object({
  identity: z.object({
    name: z.string(),
    tagline: z.string().nullable(),
    category: z.string(),
    language: Language,
    city: z.string().nullable(),
    serviceArea: z.string().nullable(),
  }),
  languageVersions: z.array(z.object({ lang: z.string(), url: z.string() })),
  palette: Palette,
  typography: Typography,
  logo: LogoInfo,
  /** До 4 assetId — кандидати лого, з яких клієнт може обрати. */
  logoCandidates: z.array(z.string()).max(4),
  voice: z.object({
    tone: z.array(z.string()),
    formality: z.enum(["formal", "neutral", "casual"]),
    description: z.string(),
  }),
  audience: z.string(),
  offerings: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      /** Ціна як на сайті (рядок), або null. */
      price: z.string().nullable(),
    }),
  ),
  usps: z.array(z.string()),
  /** Що продукт робить і як виглядає результат — дослівно з сайту (перевіряє `verifySubstance`). */
  substance: ProductSubstance.default(emptySubstance),
  socialProof: z.object({
    rating: z.number().nullable(),
    reviewsCount: z.number().int().nullable(),
    quotes: z.array(z.object({ text: z.string(), author: z.string().nullable() })),
  }),
  location: z.object({
    address: z.string().nullable(),
    city: z.string().nullable(),
    hours: z.string().nullable(),
  }),
  contacts: z.object({
    phones: z.array(z.string()),
    emails: z.array(z.string()),
    website: z.string().nullable(),
    socials: z.array(z.string()),
  }),
  cta: z.object({
    text: z.string(),
    /** Куди веде CTA: сайт, телефон, месенджер… */
    target: z.string().nullable(),
  }),
  facts: z.array(Fact),
  visualStyle: z.object({
    mood: z.array(z.string()),
    motionPersonality: MotionPersonality,
    density: z.enum(["airy", "balanced", "dense"]),
    shapes: z.enum(["rounded", "sharp", "organic", "geometric"]),
    musicHints: z.array(z.string()),
  }),
  /** Асети, ранжовані від кращого. */
  assets: z.array(RankedAsset),
  gaps: z.array(z.object({ kind: GapKind, note: z.string() })),
  confidence: z.number().min(0).max(1),
  /** 1–2 питання клієнту з дефолтами. */
  questions: z.array(BrandQuestion).max(2),
});
export type BrandKit = z.infer<typeof BrandKit>;

/** Вміст `brandkit/v<k>.json`: бренд-кіт + метадані версії. */
export const BrandKitFile = BrandKit.extend({
  version: z.number().int().min(1),
  createdAt: IsoDate,
  /** Що породило версію. */
  origin: z.enum(["llm", "patch", "logo", "facts", "answers"]),
  /** Програмні виправлення (контраст, шрифти) людською мовою. */
  fixes: z.array(z.string()),
});
export type BrandKitFile = z.infer<typeof BrandKitFile>;

/**
 * Операція JSON Patch (RFC 6902) у LLM-сумісному вигляді:
 * значення передається JSON-рядком, бо structured output не приймає довільний тип.
 */
export const JsonPatchOp = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  /** JSON Pointer, напр. /palette/primary */
  path: z.string(),
  /** JSON-кодоване значення для add/replace/test, інакше null. */
  valueJson: z.string().nullable(),
  /** Для move/copy, інакше null. */
  from: z.string().nullable(),
});
export type JsonPatchOp = z.infer<typeof JsonPatchOp>;

/** LLM-схема стадії `brandkit-patch`. */
export const BrandKitPatch = z.object({
  ops: z.array(JsonPatchOp),
  /** Коротко, що змінено — для повідомлення в чаті. */
  summary: z.string(),
});
export type BrandKitPatch = z.infer<typeof BrandKitPatch>;
