import type { Asset, BrandKitFile, Format, Palette } from "@adc/shared";
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
  };
  tone: string[];
  formality: BrandKitFile["voice"]["formality"];
  voice: string;
  audience: string;
  offerings: Array<{ name: string; price: string | null }>;
  usps: string[];
  geo: { city: string | null; address: string | null; hours: string | null; serviceArea: string | null };
  cta: string;
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
  questions: Array<{ id: string; text: string; default: string; options: string[] }>;
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
    swatches: (Object.keys(PALETTE_ROLE_UK) as Array<keyof Palette>).map((role) => ({
      role,
      label: PALETTE_ROLE_UK[role],
      hex: kit.palette[role],
    })),
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
    facts: kit.facts.map((f) => ({
      id: f.id,
      kind: f.kind,
      text: f.text,
      source: f.source,
      sourceUrl: f.sourceUrl,
      quote: f.quote,
      sourceLabel: f.source === "client" ? "від вас" : `з сайту: ${f.sourceUrl ?? "—"}`,
    })),
    questions: kit.questions.map((q) => ({ id: q.id, text: q.text, default: q.default, options: q.options })),
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
  const logo = s.logo.assetId ? `зображення ${s.logo.assetId}` : `текстом «${s.logo.textFallback}»`;
  const others = s.logoCandidates.filter((c) => c.assetId !== s.logo.assetId).map((c) => c.assetId);
  lines.push(`**Лого:** ${logo}${others.length ? `; інші варіанти: ${others.join(", ")}` : ""}`);
  const font = (f: BrandSummary["fonts"]["heading"]) =>
    `${f.family} ${f.weights.join("/")}${f.origin === "substitute" ? " (замінник)" : ""}`;
  lines.push(`**Шрифти:** заголовки — ${font(s.fonts.heading)}; текст — ${font(s.fonts.body)}`);
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
  if (s.facts.length) {
    lines.push("", "**Факти:**");
    for (const f of s.facts) lines.push(`- ${f.text} — ${f.sourceLabel}`);
  }
  if (s.questions.length) {
    lines.push("", "**Питання:**");
    for (const q of s.questions) lines.push(`- ${q.text} (якщо не відповісте: «${q.default}»)`);
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
