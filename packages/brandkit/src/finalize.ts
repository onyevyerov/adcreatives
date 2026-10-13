import type { Asset, BrandKit, Fact, RankedAsset, SiteData } from "@adc/shared";
import { contrastRatio, deriveSemanticPalette, fixPalette, normalizeHex } from "./color.ts";
import { assignFactIds, dedupeFacts, verifySiteFacts } from "./facts.ts";
import { fixTypography, primaryFamily } from "./fonts.ts";
import { verifySubstance } from "./substance.ts";

/**
 * Програмна перевірка бренд-кіта після LLM (і після патча): однакова для обох стадій.
 * Модель пропонує, код гарантує: існуючі assetId, контраст, семантичні кольори, Google Fonts
 * з кирилицею (і моношрифт), перевірені цитати фактів, дослівна «речовина продукту»,
 * `few_photos`, ліміти списків.
 */

/** Мінімум придатних фото (quality ≥ 3), нижче — gap `few_photos`. */
export const MIN_GOOD_PHOTOS = 3;
export const MIN_PHOTO_QUALITY = 3;
const MAX_LOGO_CANDIDATES = 4;

/** Типи асетів, що вважаються фото для сцен. */
const PHOTO_KINDS = new Set<Asset["kind"]>(["photo", "og", "background", "user"]);
const NON_PHOTO_ROLES = new Set<RankedAsset["role"]>(["logo", "texture"]);

export interface FinalizeInput {
  /** site.json; null — немає (тоді факти сайту не перевіряються). */
  site: SiteData | null;
  /** Актуальний assets.json. */
  assets: readonly Asset[];
  /** id фактів попередньої версії, які мають лишитися стабільними (для патча). */
  keepFactIds?: ReadonlySet<string>;
  /**
   * Текст сайту, який бачив бренд-кіт (`brandkit/site-text.txt`): за ним перевіряється `substance`.
   * null чи порожній — перевірити нема з чим, уся речовина продукту прибирається.
   */
  siteText: string | null;
  /** Перша версія: беремо languageVersions і контакти з site.json. */
  initial?: boolean;
}

export interface FinalizeResult {
  brandkit: BrandKit;
  fixes: string[];
}

/** Приводить посилання на асет до id: «a01», «#3», «3» (номер на контакт-листі) → assetId. */
export function resolveAssetRef(
  ref: string | null,
  known: ReadonlyMap<string, Asset>,
  sheetNumbers?: ReadonlyMap<number, string>,
): string | null {
  if (ref === null) return null;
  const s = ref.trim();
  if (known.has(s)) return s;
  const m = /^#?\s*(\d{1,3})$/.exec(s);
  if (m && sheetNumbers) {
    const id = sheetNumbers.get(Number(m[1]));
    if (id && known.has(id)) return id;
  }
  const lower = s.toLowerCase();
  for (const id of known.keys()) if (id.toLowerCase() === lower) return id;
  return null;
}

/** Скільки придатних фото (quality ≥ 3, не лого/іконки/текстури). */
export function countGoodPhotos(ranked: readonly RankedAsset[], assets: readonly Asset[]): number {
  const byId = new Map(assets.map((a) => [a.id, a]));
  return ranked.filter((r) => {
    const a = byId.get(r.assetId);
    return a && PHOTO_KINDS.has(a.kind) && !NON_PHOTO_ROLES.has(r.role) && r.quality >= MIN_PHOTO_QUALITY;
  }).length;
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

export function finalizeBrandKit(
  input: BrandKit,
  ctx: FinalizeInput,
  sheetNumbers?: ReadonlyMap<number, string>,
): FinalizeResult {
  const fixes: string[] = [];
  const kit = structuredClone(input) as BrandKit;
  const known = new Map(ctx.assets.map((a) => [a.id, a]));
  const ref = (r: string | null) => resolveAssetRef(r, known, sheetNumbers);

  // --- Асети: лише існуючі id, без дублікатів; фото клієнта, яких модель не бачила, — на початок.
  const ranked: RankedAsset[] = [];
  const unknownIds: string[] = [];
  for (const r of kit.assets) {
    const id = ref(r.assetId);
    if (!id) {
      unknownIds.push(r.assetId);
      continue;
    }
    if (ranked.some((x) => x.assetId === id)) continue;
    ranked.push({ ...r, assetId: id });
  }
  if (unknownIds.length) fixes.push(`Прибрано посилання на неіснуючі зображення: ${unknownIds.join(", ")}.`);
  const unranked = ctx.assets.filter((a) => a.source === "user" && !ranked.some((r) => r.assetId === a.id));
  if (unranked.length) {
    ranked.unshift(
      ...unranked.map(
        (a): RankedAsset => ({
          assetId: a.id,
          role: "other",
          quality: MIN_PHOTO_QUALITY,
          cropFocus: { x: 0.5, y: 0.5 },
          hasBakedText: false,
          description: a.alt ?? "Фото від клієнта",
        }),
      ),
    );
  }
  kit.assets = ranked;

  // --- Лого і кандидати.
  const logoId = ref(kit.logo.assetId);
  if (kit.logo.assetId !== null && logoId === null) {
    fixes.push(`Лого ${kit.logo.assetId} не знайдено серед зображень — використано текстове лого.`);
  }
  kit.logo.assetId = logoId;
  if (logoId === null) kit.logo.type = "text";
  else {
    const mime = known.get(logoId)?.mime ?? "";
    kit.logo.type = mime.includes("svg") ? "svg" : "image";
  }
  if (!kit.logo.textFallback.trim()) kit.logo.textFallback = kit.identity.name;

  const candidates = uniq([logoId, ...kit.logoCandidates.map(ref)].filter((id): id is string => id !== null));
  if (candidates.length < MAX_LOGO_CANDIDATES) {
    const extra = ctx.assets
      .filter((a) => a.isLogoCandidate && !candidates.includes(a.id))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
      .map((a) => a.id);
    candidates.push(...extra.slice(0, MAX_LOGO_CANDIDATES - candidates.length));
  }
  kit.logoCandidates = candidates.slice(0, MAX_LOGO_CANDIDATES);

  // --- Палітра.
  const pal = fixPalette(kit.palette);
  const semantic = deriveSemanticPalette(pal.palette);
  kit.palette = semantic.palette;
  fixes.push(...pal.fixes, ...semantic.fixes);

  // --- Типографіка.
  const siteFonts = (ctx.site?.design?.fonts ?? [])
    .map((f) => primaryFamily(f.family))
    .filter((f): f is string => f !== null);
  const typo = fixTypography(kit.typography, {
    language: kit.identity.language,
    brandName: kit.identity.name,
    siteFonts,
  });
  kit.typography = typo.typography;
  fixes.push(...typo.fixes);

  // --- Факти.
  const checked = verifySiteFacts(kit.facts, ctx.site);
  fixes.push(...checked.fixes);
  const facts: Fact[] = dedupeFacts(checked.facts);
  kit.facts = assignFactIds(facts, ctx.keepFactIds ?? new Set());

  // --- Речовина продукту: лише дослівні рядки з тексту сайту.
  const substance = verifySubstance(kit.substance, ctx.siteText);
  kit.substance = substance.substance;
  fixes.push(...substance.fixes);

  // --- Мовні версії й контакти беремо з краулера (вони точніші за переказ моделі).
  if (ctx.initial && ctx.site) {
    if (ctx.site.languageVersions.length)
      kit.languageVersions = ctx.site.languageVersions.map((v) => ({ ...v }));
    const c = ctx.site.contacts;
    kit.contacts.phones = uniq([...kit.contacts.phones, ...c.phones]);
    kit.contacts.emails = uniq([...kit.contacts.emails, ...c.emails]);
    kit.contacts.socials = uniq([...kit.contacts.socials, ...c.socials.map((s) => s.url)]);
    kit.contacts.website ??= ctx.site.finalUrl ?? ctx.site.url;
    if (!kit.location.address && c.addresses[0]) kit.location.address = c.addresses[0];
  }

  // --- Прогалини.
  const gaps = kit.gaps.filter((g) => g.kind !== "few_photos" && g.kind !== "no_logo");
  const good = countGoodPhotos(kit.assets, ctx.assets);
  if (good < MIN_GOOD_PHOTOS) {
    gaps.unshift({
      kind: "few_photos",
      note: `Придатних фото: ${good}, потрібно щонайменше ${MIN_GOOD_PHOTOS}.`,
    });
  }
  if (kit.logo.assetId === null && kit.logoCandidates.length === 0) {
    gaps.push({ kind: "no_logo", note: "На сайті не знайдено лого — використаємо назву текстом." });
  }
  const hasContacts =
    kit.contacts.phones.length + kit.contacts.emails.length + kit.contacts.socials.length > 0 ||
    kit.contacts.website !== null;
  if (!hasContacts && !gaps.some((g) => g.kind === "no_contacts")) {
    gaps.push({ kind: "no_contacts", note: "Контактів не знайдено." });
  }
  kit.gaps = gaps;

  // --- Дрібниці: ліміти, діапазони.
  kit.confidence = Math.min(1, Math.max(0, kit.confidence));
  // Питання власнику тимчасово вимкнені: акцент, аудиторію й CTA обирає сценарист сам.
  kit.questions = [];
  if (kit.socialProof.rating !== null && (kit.socialProof.rating < 0 || kit.socialProof.rating > 5)) {
    fixes.push(`Рейтинг ${kit.socialProof.rating} поза шкалою 0–5 — прибрано.`);
    kit.socialProof.rating = null;
  }

  return { brandkit: kit, fixes: uniq(fixes) };
}

/** Чи лого погано видно на фоні бренду: контраст домінантних кольорів лого з фоном < 1.5. */
export function logoNeedsBackground(asset: Asset, background: string): boolean {
  const colors = asset.dominantColors.map(normalizeHex).filter((c): c is string => c !== null);
  if (!colors.length) return false;
  return Math.max(...colors.map((c) => contrastRatio(c, background))) < 1.5;
}
