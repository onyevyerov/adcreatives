import {
  type Asset,
  type BasePaletteRole,
  type BrandKitFile,
  type Format,
  type Palette,
  SEMANTIC_PALETTE_ROLES,
  type SemanticPaletteRole,
} from "@adc/shared";
import { PALETTE_ROLE_UK } from "./color.ts";
import { countGoodPhotos, MIN_GOOD_PHOTOS, MIN_PHOTO_QUALITY } from "./finalize.ts";

/**
 * Резюме бренд-кіта для чекпоінта 1. Структура — для шаблонів чату (B7/B6),
 * плюс готовий текст українською (`formatBrandSummaryText`) і payload чекпоінта.
 */

export interface MediaLink {
  assetId: string;
  url: string;
}

export interface BrandSummary {
  version: number;
  name: string;
  tagline: string | null;
  category: string;
  language: BrandKitFile["identity"]["language"];
  swatches: Array<{ role: keyof Palette; label: string; hex: string }>;
  /** Семантичні кольори (помилка / попередження / успіх); null у старих бренд-кітах пропускаються. */
  semantic: Array<{ role: SemanticPaletteRole; label: string; hex: string }>;
  logo: {
    assetId: string | null;
    url: string | null;
    type: BrandKitFile["logo"]["type"];
    textFallback: string;
    needsBackground: boolean;
  };
  logoCandidates: MediaLink[];
  fonts: {
    heading: { family: string; weights: number[]; origin: "site" | "substitute" };
    body: { family: string; weights: number[]; origin: "site" | "substitute" };
    /** Моношрифт для чисел і міток; null — старий бренд-кіт (тема візьме JetBrains Mono). */
    mono: { family: string; weights: number[]; origin: "site" | "substitute" } | null;
  };
  tone: string[];
  formality: BrandKitFile["voice"]["formality"];
  voice: string;
  audience: string;
  offerings: Array<{ name: string; price: string | null }>;
  usps: string[];
  geo: { city: string | null; address: string | null; hours: string | null; serviceArea: string | null };
  cta: string;
  /** Речовина продукту для сцен «що перевіряє» і «приклад результату» — дослівно з сайту. */
  substance: {
    steps: string[];
    checks: string[];
    examples: string[];
    planRows: string[];
    products: string[];
    comparisons: string[];
  };
  facts: Array<{
    id: string;
    kind: string;
    text: string;
    source: "site" | "client";
    sourceUrl: string | null;
    quote: string | null;
    /** «з сайту: <url>» / «від вас». */
    sourceLabel: string;
  }>;
  gaps: Array<{ kind: string; note: string }>;
  /** Найкращі фото (quality ≥ 3), до 8. */
  photos: MediaLink[];
  goodPhotos: number;
  needMorePhotos: boolean;
  /** Скільки фото бракує до мінімуму. */
  missingPhotos: number;
  languageOptions: Array<{ lang: string; url: string }>;
  fixes: string[];
}

const SEMANTIC_ROLE_UK: Record<SemanticPaletteRole, string> = {
  danger: "помилка",
  warning: "попередження",
  success: "успіх",
};

export interface SummaryOptions {
  /** Ключ сховища → URL для браузера (`storage.publicUrl`). */
  publicUrl: (key: string) => string;
}

export function summarizeBrandKit(
  kit: BrandKitFile,
  assets: readonly Asset[],
  opts: SummaryOptions,
): BrandSummary {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const link = (id: string): MediaLink | null => {
    const a = byId.get(id);
    return a ? { assetId: id, url: opts.publicUrl(a.path) } : null;
  };
  const good = countGoodPhotos(kit.assets, assets);
  const photos = kit.assets
    .filter((r) => r.quality >= MIN_PHOTO_QUALITY && r.role !== "logo")
    .map((r) => link(r.assetId))
    .filter((l): l is MediaLink => l !== null)
    .slice(0, 8);

  return {
    version: kit.version,
    name: kit.identity.name,
    tagline: kit.identity.tagline,
    category: kit.identity.category,
    language: kit.identity.language,
    swatches: (Object.keys(PALETTE_ROLE_UK) as BasePaletteRole[]).map((role) => ({
      role,
      label: PALETTE_ROLE_UK[role],
      hex: kit.palette[role],
    })),
    semantic: SEMANTIC_PALETTE_ROLES.flatMap((role) => {
      const hex = kit.palette[role];
      return hex ? [{ role, label: SEMANTIC_ROLE_UK[role], hex }] : [];
    }),
    logo: {
      assetId: kit.logo.assetId,
      url: kit.logo.assetId ? (link(kit.logo.assetId)?.url ?? null) : null,
      type: kit.logo.type,
      textFallback: kit.logo.textFallback,
      needsBackground: kit.logo.needsBackground,
    },
    logoCandidates: kit.logoCandidates.map(link).filter((l): l is MediaLink => l !== null),
    fonts: {
      heading: { ...kit.typography.heading },
      body: { ...kit.typography.body },
      mono: kit.typography.mono ? { ...kit.typography.mono } : null,
    },
    tone: kit.voice.tone,
    formality: kit.voice.formality,
    voice: kit.voice.description,
    audience: kit.audience,
    offerings: kit.offerings.map((o) => ({ name: o.name, price: o.price })),
    usps: kit.usps,
    geo: {
      city: kit.location.city ?? kit.identity.city,
      address: kit.location.address,
      hours: kit.location.hours,
      serviceArea: kit.identity.serviceArea,
    },
    cta: kit.cta.text,
    substance: {
      steps: kit.substance.steps.map((st) => st.name),
      checks: [...kit.substance.checks],
      examples: kit.substance.exampleIssues.map((e) => e.title),
      planRows: kit.substance.planRows.map((r) => r.text),
      products: kit.substance.products.map((p) => p.name),
      comparisons: kit.substance.comparisons.map((c) => c.criterion),
    },
    facts: kit.facts.map((f) => ({
      id: f.id,
      kind: f.kind,
      text: f.text,
      source: f.source,
      sourceUrl: f.sourceUrl,
      quote: f.quote,
      sourceLabel: f.source === "client" ? "від вас" : `з сайту: ${f.sourceUrl ?? "—"}`,
    })),
    gaps: kit.gaps.map((g) => ({ kind: g.kind, note: g.note })),
    photos,
    goodPhotos: good,
    needMorePhotos: good < MIN_GOOD_PHOTOS,
    missingPhotos: Math.max(0, MIN_GOOD_PHOTOS - good),
    languageOptions: kit.languageVersions.length > 1 ? kit.languageVersions : [],
    fixes: kit.fixes,
  };
}

const FORMALITY_UK = { formal: "офіційний", neutral: "нейтральний", casual: "невимушений" } as const;

/** Текст резюме для повідомлення в чаті (Markdown-подібний, українською). */
export function formatBrandSummaryText(s: BrandSummary): string {
  const lines: string[] = [];
  lines.push(`**${s.name}**${s.tagline ? ` — ${s.tagline}` : ""} (${s.category})`);
  lines.push("");
  lines.push(`**Палітра:** ${s.swatches.map((w) => `${w.label} ${w.hex}`).join(", ")}`);
  if (s.semantic.length) {
    lines.push(`**Кольори станів:** ${s.semantic.map((w) => `${w.label} ${w.hex}`).join(", ")}`);
  }
  const logo = s.logo.assetId ? `зображення ${s.logo.assetId}` : `текстом «${s.logo.textFallback}»`;
  const others = s.logoCandidates.filter((c) => c.assetId !== s.logo.assetId).map((c) => c.assetId);
  lines.push(`**Лого:** ${logo}${others.length ? `; інші варіанти: ${others.join(", ")}` : ""}`);
  const font = (f: BrandSummary["fonts"]["heading"]) =>
    `${f.family} ${f.weights.join("/")}${f.origin === "substitute" ? " (замінник)" : ""}`;
  const mono = s.fonts.mono ? `; цифри й мітки — ${font(s.fonts.mono)}` : "";
  lines.push(`**Шрифти:** заголовки — ${font(s.fonts.heading)}; текст — ${font(s.fonts.body)}${mono}`);
  lines.push(`**Тон:** ${s.tone.join(", ")} — ${FORMALITY_UK[s.formality]}`);
  if (s.offerings.length) {
    lines.push(
      `**Послуги:** ${s.offerings
        .slice(0, 8)
        .map((o) => (o.price ? `${o.name} (${o.price})` : o.name))
        .join("; ")}`,
    );
  }
  const geo = [s.geo.address ?? s.geo.city, s.geo.hours, s.geo.serviceArea].filter(Boolean);
  if (geo.length) lines.push(`**Гео:** ${geo.join(" · ")}`);
  lines.push(`**CTA:** ${s.cta}`);
  const product = [
    ["Кроки", s.substance.steps],
    ["Що перевіряє", s.substance.checks],
    ["Приклади результату", s.substance.examples],
    ["План", s.substance.planRows],
    ["Продукти", s.substance.products],
    ["Порівняння", s.substance.comparisons],
  ] as const;
  if (product.some(([, items]) => items.length)) {
    lines.push("", "**Продукт у ролику (дослівно з сайту):**");
    for (const [label, items] of product) {
      if (items.length) lines.push(`- ${label}: ${items.slice(0, 6).join("; ")}`);
    }
  }
  if (s.facts.length) {
    lines.push("", "**Факти:**");
    for (const f of s.facts) lines.push(`- ${f.text} — ${f.sourceLabel}`);
  }
  if (s.needMorePhotos) {
    lines.push("", `Придатних фото замало — додайте, будь ласка, ще хоча б ${s.missingPhotos}.`);
  }
  return lines.join("\n");
}

/**
 * Частина payload чекпоінта `brand` (схема `BrandCheckpointPayload` у shared/events).
 * `formats` — з project.json, їх знає оркестратор.
 */
export function brandCheckpointPayload(
  kit: BrandKitFile,
  assets: readonly Asset[],
  opts: SummaryOptions & { formats: Format[] },
) {
  const s = summarizeBrandKit(kit, assets, opts);
  return {
    checkpoint: "brand" as const,
    brandkit: kit,
    logoCandidates: s.logoCandidates,
    photos: s.photos,
    formats: opts.formats,
    languageOptions: s.languageOptions,
    needMorePhotos: s.needMorePhotos,
  };
}
