import type { FontChoice, FontFile, Language, Logger, SiteFontFace, Storage, Typography } from "@adc/shared";
import { create as openFont } from "fontkit";
import { z } from "zod";
import fontsData from "./fonts.json" with { type: "json" };

/**
 * Мапінг шрифтів на Google Fonts за курованим списком `fonts.json`.
 * Для української (або кириличної назви бренду) шрифт обов'язково має підмножину `cyrillic`.
 */

export const FontCategory = z.enum(["sans-serif", "serif", "display", "handwriting", "monospace"]);
export type FontCategory = z.infer<typeof FontCategory>;

const FontsFile = z.object({
  note: z.string(),
  fonts: z.array(
    z.object({
      family: z.string(),
      category: FontCategory,
      subsets: z.array(z.string()).min(1),
      weights: z.array(z.number().int()).min(1),
    }),
  ),
  substitutes: z.record(z.string(), z.string()),
  fallbacks: z.record(FontCategory, z.object({ heading: z.string(), body: z.string() })),
});
export type GoogleFont = z.infer<typeof FontsFile>["fonts"][number];

const DATA = FontsFile.parse(fontsData);
const BY_KEY = new Map(DATA.fonts.map((f) => [fontKey(f.family), f]));

const GENERIC = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "inherit",
  "initial",
  "emoji",
  "math",
]);

function fontKey(family: string): string {
  return family
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** `"Montserrat", Arial, sans-serif` → `Montserrat`; лише generic-сімейства → null. */
export function primaryFamily(cssFamily: string): string | null {
  for (const part of cssFamily.split(",")) {
    const name = part
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    if (name && !GENERIC.has(name.toLowerCase())) return name;
  }
  return null;
}

export function findGoogleFont(family: string): GoogleFont | null {
  const name = primaryFamily(family) ?? family;
  return BY_KEY.get(fontKey(name)) ?? null;
}

export function hasCyrillic(font: GoogleFont): boolean {
  return font.subsets.includes("cyrillic");
}

/** Список шрифтів (для тестів і підказки моделі). */
export function googleFonts(): readonly GoogleFont[] {
  return DATA.fonts;
}

/** Чи потрібна кирилиця: мова відео українська або назва бренду кирилична. */
export function needsCyrillic(language: Language, brandName = ""): boolean {
  return language === "uk" || /[Ѐ-ӿ]/.test(brandName);
}

/** Накреслення за замовчуванням, якщо модель їх не дала. */
const DEFAULT_WEIGHTS: Record<Role, number[]> = { heading: [700], body: [400], mono: [400, 700] };

function nearestWeights(requested: readonly number[], available: readonly number[], role: Role): number[] {
  const wanted = requested.length ? requested : DEFAULT_WEIGHTS[role];
  const out = new Set<number>();
  for (const w of wanted) {
    const nearest = available.reduce((best, a) => (Math.abs(a - w) < Math.abs(best - w) ? a : best));
    out.add(nearest);
  }
  return [...out].sort((a, b) => a - b);
}

type Role = "heading" | "body" | "mono";

/** Моношрифт за замовчуванням (з кирилицею); та сама назва — у motion-kit. */
export const DEFAULT_MONO = "JetBrains Mono";

export interface FontResolution {
  choice: FontChoice;
  /** null — без змін. */
  fix: string | null;
}

const ROLE_UK: Record<Role, string> = { heading: "заголовків", body: "тексту", mono: "чисел і міток" };

/** Завантажений краулером файл шрифту сайту (`design.fontFaces` з `path`) і чи є в ньому кирилиця. */
export interface SiteFontFile {
  /** Назва сімейства з `@font-face` дослівно. */
  family: string;
  weight: number;
  format: FontFile["format"];
  /** Ключ у сховищі: crawl/fonts/<fontKey>-<weight>.<ext>. */
  path: string;
  cyrillic: boolean;
}

/** Українські літери, які мають бути у файлі: ж, ї, є, ґ. */
const CYRILLIC_PROBE = [0x436, 0x457, 0x454, 0x491];

/** Чи має файл шрифту гліфи української абетки (fontkit; колекції й биті файли — ні). */
export function fontHasCyrillic(data: Buffer): boolean {
  const font = openFont(data);
  if (!("hasGlyphForCodePoint" in font)) return false;
  return CYRILLIC_PROBE.every((cp) => font.hasGlyphForCodePoint(cp));
}

/**
 * Читає зі сховища файли шрифтів сайту, які завантажив краулер (лише `normal` з `path`), і
 * перевіряє кирилицю. Файл, що не читається або не розбирається, пропускається.
 */
export async function loadSiteFonts(
  storage: Pick<Storage, "read">,
  faces: readonly SiteFontFace[],
  logger?: Logger,
): Promise<SiteFontFile[]> {
  const out: SiteFontFile[] = [];
  for (const face of faces) {
    if (face.path === null || face.style !== "normal") continue;
    if (face.weight < 100 || face.weight > 900) continue;
    try {
      const cyrillic = fontHasCyrillic(await storage.read(face.path));
      out.push({ family: face.family, weight: face.weight, format: face.format, path: face.path, cyrillic });
    } catch (err) {
      logger?.warn("файл шрифту сайту не прочитано", { path: face.path, error: (err as Error).message });
    }
  }
  return out;
}

export interface ResolveFontOptions {
  cyrillic: boolean;
  detected: readonly string[];
  /**
   * Файли шрифтів сайту (`loadSiteFonts`). Не передано — даних про файли немає (напр. правка
   * бренд-кіта): тоді вже вибраний `origin: "local"` лишається як є.
   */
  local?: readonly SiteFontFile[];
}

/**
 * Локальні файли сайту для сімейства: з кирилицею (якщо потрібна), найближчі до запитаних ваги.
 * null — файлів немає або жоден не підходить.
 */
function localChoice(
  choice: FontChoice,
  requested: string,
  role: Role,
  opts: ResolveFontOptions,
): FontChoice | null {
  const key = fontKey(requested);
  if (role === "mono") return null;
  if (opts.local === undefined) {
    const keep =
      choice.origin === "local" &&
      choice.files.length > 0 &&
      choice.files.every((f) => f.path.includes("/crawl/fonts/")) &&
      fontKey(choice.family) === key;
    return keep ? choice : null;
  }
  const files = opts.local.filter((f) => fontKey(f.family) === key && (!opts.cyrillic || f.cyrillic));
  if (files.length === 0) return null;
  const weights = nearestWeights(
    choice.weights,
    files.map((f) => f.weight),
    role,
  );
  const chosen = weights.map((w) => files.find((f) => f.weight === w) as SiteFontFile);
  return {
    family: (chosen[0] as SiteFontFile).family,
    weights,
    origin: "local",
    files: chosen.map((f) => ({ weight: f.weight, style: "normal", format: f.format, path: f.path })),
  };
}

/**
 * Перевіряє одну роль: шрифт є в списку і (за потреби) має кирилицю.
 * Інакше — файли шрифту з сайту (`origin: "local"`, якщо є і з кирилицею), далі заміна з
 * `substitutes`, потім запасний шрифт тієї ж категорії.
 */
export function resolveFont(choice: FontChoice, role: Role, opts: ResolveFontOptions): FontResolution {
  const ok = (f: GoogleFont | null | undefined): boolean => !!f && (!opts.cyrillic || hasCyrillic(f));
  const detectedKeys = new Set(opts.detected.map((d) => fontKey(primaryFamily(d) ?? d)));
  const requested = primaryFamily(choice.family) ?? choice.family;
  const found = findGoogleFont(requested);
  const roleUk = ROLE_UK[role];

  const build = (font: GoogleFont): FontChoice => ({
    family: font.family,
    weights: nearestWeights(choice.weights, font.weights, role),
    origin: detectedKeys.has(fontKey(font.family)) ? "site" : "substitute",
    files: [],
  });

  if (found && ok(found)) return { choice: build(found), fix: null };

  const local = localChoice(choice, requested, role, opts);
  if (local) {
    // Повторна нормалізація вже локального вибору (правка бренд-кіта) — без нового повідомлення.
    const fix = choice.origin === "local" ? null : `Шрифт ${roleUk} «${local.family}» узято з сайту.`;
    return { choice: local, fix };
  }

  const subName = DATA.substitutes[fontKey(requested)];
  const sub = subName ? findGoogleFont(subName) : null;
  const category: FontCategory = found?.category ?? guessCategory(requested);
  const fallbackName =
    role === "mono"
      ? DEFAULT_MONO
      : (DATA.fallbacks[category]?.[role] ?? (role === "heading" ? "Montserrat" : "Inter"));
  const replacement = sub && ok(sub) ? sub : findGoogleFont(fallbackName);
  if (!replacement || !ok(replacement)) {
    throw new Error(`fonts.json: запасний шрифт ${fallbackName} відсутній або без кирилиці`);
  }

  const reason = found ? "не має кирилиці" : "немає в перевіреному списку Google Fonts";
  return {
    choice: build(replacement),
    fix: `Шрифт ${roleUk} «${requested}» ${reason} — замінено на «${replacement.family}».`,
  };
}

function guessCategory(family: string): FontCategory {
  const k = fontKey(family);
  if (/mono|code|courier/.test(k)) return "monospace";
  if (/script|hand|brush|marker/.test(k)) return "handwriting";
  if (/serif|garamond|times|georgia|baskerville|bodoni|didot|playfair|antiqua/.test(k) && !/sans/.test(k))
    return "serif";
  return "sans-serif";
}

const isMono = (family: string): boolean => findGoogleFont(family)?.category === "monospace";

/**
 * Моношрифт для чисел, eyebrow і міток — завжди заповнений.
 * Модель дала шрифт: перевірка як для інших ролей, плюс він має бути моноширинним.
 * null: якщо шрифт бренду (текст, потім заголовки) сам моно — він; інакше `JetBrains Mono`.
 */
export function resolveMono(
  choice: FontChoice | null,
  brand: { heading: FontChoice; body: FontChoice },
  opts: { cyrillic: boolean; detected: readonly string[] },
): FontResolution {
  const fallback = (fix: string | null): FontResolution => ({
    ...resolveFont(
      { family: DEFAULT_MONO, weights: choice?.weights ?? [], origin: "substitute", files: [] },
      "mono",
      opts,
    ),
    fix,
  });
  if (choice === null) {
    const own = [brand.body, brand.heading].find((f) => isMono(f.family));
    if (!own) return fallback(null);
    return { ...resolveFont({ ...own, weights: [] }, "mono", opts), fix: null };
  }
  const res = resolveFont(choice, "mono", opts);
  if (isMono(res.choice.family)) return res;
  const requested = primaryFamily(choice.family) ?? choice.family;
  return fallback(`Шрифт чисел і міток «${requested}» не моноширинний — замінено на «${DEFAULT_MONO}».`);
}

export interface TypographyFixResult {
  typography: Typography;
  fixes: string[];
}

/** Нормалізує типографіку бренд-кіта: Google Fonts, кирилиця, наявні накреслення, `detected`. */
export function fixTypography(
  input: Typography,
  opts: {
    language: Language;
    brandName?: string;
    siteFonts?: readonly string[];
    /** Файли шрифтів сайту (`loadSiteFonts`); лише для заголовків і тексту. */
    localFonts?: readonly SiteFontFile[];
  },
): TypographyFixResult {
  const detected: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(opts.siteFonts ?? []), ...input.detected]) {
    const name = primaryFamily(raw);
    if (!name || seen.has(fontKey(name))) continue;
    seen.add(fontKey(name));
    detected.push(name);
  }
  const cyrillic = needsCyrillic(opts.language, opts.brandName);
  const local = opts.localFonts;
  const heading = resolveFont(input.heading, "heading", { cyrillic, detected, local });
  const body = resolveFont(input.body, "body", { cyrillic, detected, local });
  const mono = resolveMono(
    input.mono,
    { heading: heading.choice, body: body.choice },
    { cyrillic, detected },
  );
  return {
    typography: { heading: heading.choice, body: body.choice, mono: mono.choice, detected },
    fixes: [heading.fix, body.fix, mono.fix].filter((f): f is string => f !== null),
  };
}
