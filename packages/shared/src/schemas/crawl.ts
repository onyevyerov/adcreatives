import { z } from "zod";
import { IsoDate } from "./common.ts";

/** Результати краулера: `crawl/site.json` і `crawl/assets.json`. Не LLM-схеми. */

export const LanguageVersion = z.object({
  /** Код мови як на сайті: uk, en, ru, … */
  lang: z.string(),
  url: z.url(),
});
export type LanguageVersion = z.infer<typeof LanguageVersion>;

export const PageHeading = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string(),
});

export const PageData = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  lang: z.string().nullable(),
  headings: z.array(PageHeading),
  /** Основний текст без шапки/футера (Readability). */
  text: z.string(),
  buttons: z.array(z.string()),
  /** Сирі блоки JSON-LD (LocalBusiness, Organization, Product, FAQ). */
  jsonLd: z.array(z.unknown()),
  og: z.record(z.string(), z.string()),
  /** Ключ у сховищі першого екрана сторінки (crawl/screenshots/…png) або null. */
  screenshot: z.string().nullable(),
});
export type PageData = z.infer<typeof PageData>;

export const SocialLink = z.object({ network: z.string(), url: z.string() });

export const Contacts = z.object({
  phones: z.array(z.string()),
  emails: z.array(z.string()),
  addresses: z.array(z.string()),
  socials: z.array(SocialLink),
});
export type Contacts = z.infer<typeof Contacts>;

export const ColorRole = z.enum(["background", "heading", "text", "button", "buttonText", "link"]);

export const DesignStats = z.object({
  /** CSS-змінні з :root. */
  cssVars: z.record(z.string(), z.string()),
  colors: z.array(z.object({ role: ColorRole, value: z.string(), count: z.number().int() })),
  fonts: z.array(
    z.object({
      role: z.enum(["h1", "h2", "body", "button"]),
      family: z.string(),
      weight: z.number().int(),
    }),
  ),
  buttonRadius: z.string().nullable(),
});
export type DesignStats = z.infer<typeof DesignStats>;

export const Screenshot = z.object({
  pageUrl: z.string(),
  /** Ключ у сховищі (crawl/screenshots/<n>.png). */
  path: z.string(),
  viewport: z.enum(["first", "below-1", "below-2"]),
  width: z.number().int(),
  height: z.number().int(),
});

export const SiteData = z.object({
  source: z.enum(["site", "manual"]),
  /** Введена адреса (для manual — null). */
  url: z.string().nullable(),
  /** Адреса після редиректів. */
  finalUrl: z.string().nullable(),
  crawledAt: IsoDate,
  /** Хоча б головна завантажилась, але не все (ліміт часу, помилки). */
  partial: z.boolean(),
  /** `lang` введеної сторінки. */
  language: z.string().nullable(),
  languageVersions: z.array(LanguageVersion),
  pages: z.array(PageData),
  navigation: z.array(z.object({ text: z.string(), url: z.string() })),
  contacts: Contacts,
  design: DesignStats.nullable(),
  screenshots: z.array(Screenshot),
  /** Для source=manual — текст, який клієнт написав у чаті. */
  manualText: z.string().nullable(),
  stats: z.object({
    pagesVisited: z.number().int(),
    pagesFailed: z.number().int(),
    durationMs: z.number().int(),
  }),
});
export type SiteData = z.infer<typeof SiteData>;

export const AssetKind = z.enum(["photo", "logo", "icon", "og", "background", "user"]);

export const Asset = z.object({
  /** a01… для асетів сайту, u01… для фото клієнта. */
  id: z.string(),
  kind: AssetKind,
  source: z.enum(["site", "user"]),
  /** Ключ у сховищі (crawl/assets/<id>.<ext> або uploads/<file>). */
  path: z.string(),
  originUrl: z.string().nullable(),
  pageUrl: z.string().nullable(),
  mime: z.string(),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  /** pHash у hex для дедупу. */
  phash: z.string().nullable(),
  dominantColors: z.array(z.string()),
  alt: z.string().nullable(),
  /** Текстове оточення зображення на сторінці. */
  context: z.string().nullable(),
  isLogoCandidate: z.boolean(),
  /** Пріоритет: фото клієнта завжди вище за асети сайту. */
  priority: z.number().int(),
});
export type Asset = z.infer<typeof Asset>;

export const AssetManifest = z.object({
  assets: z.array(Asset),
  updatedAt: IsoDate,
});
export type AssetManifest = z.infer<typeof AssetManifest>;
