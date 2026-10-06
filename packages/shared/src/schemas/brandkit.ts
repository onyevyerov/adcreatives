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
});
export type Palette = z.infer<typeof Palette>;

export const FontChoice = z.object({
  /** Назва в Google Fonts. */
  family: z.string(),
  weights: z.array(z.number().int().min(100).max(900)).min(1),
  /** Звідки шрифт: виявлений на сайті і знайдений у Google Fonts, або підібраний замінник. */
  origin: z.enum(["site", "substitute"]),
});
export type FontChoice = z.infer<typeof FontChoice>;

export const Typography = z.object({
  heading: FontChoice,
  body: FontChoice,
  /** Сімейства, виявлені на сайті як є. */
  detected: z.array(z.string()),
});
export type Typography = z.infer<typeof Typography>;

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
