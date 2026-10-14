import { createHash } from "node:crypto";
import { type DesignStats, type Logger, projectPaths, type SiteFontFace, type Storage } from "@adc/shared";
import type { Page, Response } from "playwright";
import { safeFetch } from "./fetch.ts";
import type { UrlGuard } from "./guard.ts";
import { mapPool, withTimeout } from "./util.ts";

/**
 * Шрифти сайту: `@font-face` з CSS-відповідей і вбудованих стилів, вибір файлів для сімейств,
 * які сайт реально використовує в заголовках, тексті й кнопках, і їх завантаження у сховище.
 * Бренд-кіт бере ці файли, якщо сімейства немає в Google Fonts (`origin: "local"`).
 */

export type FontFormat = SiteFontFace["format"];

/** Ліміти завантаження зі специфікації. */
export const FONT_LIMITS = {
  maxFiles: 6,
  maxBytes: 2 * 1024 * 1024,
  /** Скільки таблиць стилів читати зі сторінок (дедуп за адресою). */
  maxStylesheets: 80,
  maxStylesheetBytes: 3 * 1024 * 1024,
  /** Скільки `@font-face` лишати в site.json. */
  maxFaces: 60,
} as const;

const FORMAT_PRIORITY: readonly FontFormat[] = ["woff2", "woff", "truetype", "opentype"];
const FORMAT_EXT: Record<FontFormat, string> = {
  woff2: "woff2",
  woff: "woff",
  truetype: "ttf",
  opentype: "otf",
};
/** Ролі `design.fonts`, для сімейств яких завантажуємо файли. */
const DOWNLOAD_ROLES = new Set(["h1", "h2", "body", "button"]);

/** Текст CSS і адреса, відносно якої резолвляться `url()` (таблиця стилів або сторінка). */
export interface CssSource {
  css: string;
  baseUrl: string;
}

/** Нормалізована назва сімейства для порівняння (та сама, що в бренд-кіті). */
export function fontKey(family: string): string {
  return family
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Безпечна частина імені файлу: `Zerno Display` → `zerno-display`; не-латиниця — за хешем. */
export function fontFileKey(family: string): string {
  const key = fontKey(family);
  const slug = key
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `font-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
}

/** Розбиває рядок за роздільником поза дужками й лапками (`data:` у `src` містить `;` і `,`). */
function splitTop(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
    .trim();

/** `normal` → 400, `bold` → 700, діапазон "400 700" → нижня межа. */
export function parseFontWeight(value: string | undefined): number | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v || v === "normal") return 400;
  if (v === "bold") return 700;
  const m = /^(\d+(?:\.\d+)?)/.exec(v);
  if (!m) return null;
  const n = Math.round(Number(m[1]));
  return n >= 1 && n <= 1000 ? n : null;
}

function formatOf(hint: string | null, url: string): FontFormat | null {
  const h = (hint ?? "").toLowerCase();
  if (h) {
    if (h.startsWith("woff2")) return "woff2";
    if (h.startsWith("woff")) return "woff";
    if (h.startsWith("truetype")) return "truetype";
    if (h.startsWith("opentype")) return "opentype";
    // embedded-opentype, svg, collection — не підтримуємо.
    return null;
  }
  const path = url.replace(/[?#].*$/, "").toLowerCase();
  if (path.endsWith(".woff2")) return "woff2";
  if (path.endsWith(".woff")) return "woff";
  if (path.endsWith(".ttf")) return "truetype";
  if (path.endsWith(".otf")) return "opentype";
  return null;
}

/** Синхронна частина `safeUrl`: абсолютна http(s)-адреса без облікових даних; приватні IP відсіює guard. */
function resolveFontUrl(raw: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  return url.href;
}

/** Перший `src` за пріоритетом woff2 → woff → truetype → opentype; `local()` і `data:` пропускаємо. */
function pickSrc(value: string, baseUrl: string): { url: string; format: FontFormat } | null {
  let best: { url: string; format: FontFormat } | null = null;
  for (const item of splitTop(value, ",")) {
    const m = /url\(\s*([\s\S]*?)\s*\)/i.exec(item);
    if (!m) continue;
    const raw = unquote(m[1] ?? "");
    if (!raw || /^data:/i.test(raw)) continue;
    const hint = /format\(\s*([^)]*)\)/i.exec(item);
    const format = formatOf(hint ? unquote(hint[1] ?? "") : null, raw);
    if (!format) continue;
    const url = resolveFontUrl(raw, baseUrl);
    if (!url) continue;
    if (!best || FORMAT_PRIORITY.indexOf(format) < FORMAT_PRIORITY.indexOf(best.format))
      best = { url, format };
  }
  return best;
}

/** Усі `@font-face` з тексту CSS (path ще null; перевірку хоста робить `allowedFontFaces`). */
export function parseFontFaces(css: string, baseUrl: string): SiteFontFace[] {
  const out: SiteFontFace[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const decl = new Map<string, string>();
    for (const part of splitTop(m[1] ?? "", ";")) {
      const colon = part.indexOf(":");
      if (colon <= 0) continue;
      decl.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
    }
    const family = unquote(decl.get("font-family") ?? "");
    const src = decl.get("src");
    if (!family || !src) continue;
    const weight = parseFontWeight(decl.get("font-weight"));
    if (weight === null) continue;
    const styleRaw = (decl.get("font-style") ?? "normal").trim().toLowerCase();
    const picked = pickSrc(src, baseUrl);
    if (!picked) continue;
    const range = (decl.get("unicode-range") ?? "").replace(/\s+/g, "");
    out.push({
      family: family.replace(/\s+/g, " "),
      weight,
      style: styleRaw.startsWith("italic") || styleRaw.startsWith("oblique") ? "italic" : "normal",
      format: picked.format,
      url: picked.url,
      unicodeRange: range ? range.toUpperCase() : null,
      path: null,
    });
  }
  return out;
}

/** Лишає грані з адресами, які пропускає guard (`safeUrl` + DNS із кешем за хостом). */
export async function allowedFontFaces(
  faces: readonly SiteFontFace[],
  guard: UrlGuard,
): Promise<SiteFontFace[]> {
  const allowed: SiteFontFace[] = [];
  for (const f of faces) if (await guard.isAllowed(f.url)) allowed.push(f);
  return allowed;
}

/**
 * Збирач CSS-відповідей (`resourceType` stylesheet) зі всіх вкладок контексту: текст читається
 * одразу, поки ресурс живий; `flush` чекає незавершені читання не довше за `ms`.
 */
export function createStylesheetCollector(logger: Logger) {
  const seen = new Set<string>();
  const pending: Array<Promise<void>> = [];
  const ready: CssSource[] = [];
  const onResponse = (res: Response) => {
    try {
      if (res.request().resourceType() !== "stylesheet" || res.status() !== 200) return;
      const url = res.url();
      if (seen.has(url) || seen.size >= FONT_LIMITS.maxStylesheets) return;
      seen.add(url);
      pending.push(
        res.body().then(
          (body) => {
            if (body.length <= FONT_LIMITS.maxStylesheetBytes && body.includes("@font-face"))
              ready.push({ css: body.toString("utf8"), baseUrl: url });
          },
          (err: Error) => {
            logger.debug("CSS не прочитано", { url, error: err.message });
          },
        ),
      );
    } catch {
      // Відповідь уже недоступна — пропускаємо.
    }
  };
  /** Прочитані таблиці; що не встигло за `ms` — пропускається. */
  const flush = async (ms: number): Promise<CssSource[]> => {
    await withTimeout(Promise.all(pending), ms, "читання CSS").catch(() => {});
    return [...ready];
  };
  return { onResponse, flush };
}

/**
 * Вбудовані стилі сторінки (`<style>` і правила, вставлені скриптами): лише `@font-face`.
 * Рядком, а не функцією — як `inpage.js` (транспіляція не додає `__name`).
 */
const INLINE_FONT_CSS = `(() => {
  const out = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (r.type === 5) out.push(r.cssText);
      else if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href) continue;
    try { walk(sheet.cssRules); }
    catch { const t = sheet.ownerNode && sheet.ownerNode.textContent; if (t && t.includes("@font-face")) out.push(t); }
  }
  return { baseUrl: document.baseURI, css: out.join("\\n").slice(0, ${FONT_LIMITS.maxStylesheetBytes}) };
})()`;

export async function inlineFontCss(page: Page): Promise<CssSource | null> {
  const res = (await page.evaluate(INLINE_FONT_CSS)) as CssSource;
  return res.css ? res : null;
}

const groupKey = (f: SiteFontFace) => `${fontKey(f.family)}|${f.weight}`;

/** Чи покриває `unicode-range` кириличну літеру «ж» (U+0436). */
function coversCyrillic(range: string | null): boolean {
  if (range === null) return true;
  for (const part of range.split(",")) {
    const m = /^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i.exec(part.trim());
    if (!m) continue;
    const startHex = (m[1] ?? "").replace(/\?/g, "0");
    const endHex = m[2] ?? (m[1] ?? "").replace(/\?/g, "F");
    if (Number.parseInt(startHex, 16) <= 0x436 && 0x436 <= Number.parseInt(endHex, 16)) return true;
  }
  return false;
}

/** Найкраща грань у групі (сімейство + вага): повний файл → з кирилицею → перша. */
function bestOf(group: SiteFontFace[]): SiteFontFace {
  return (
    group.find((f) => f.unicodeRange === null) ??
    group.find((f) => coversCyrillic(f.unicodeRange)) ??
    (group[0] as SiteFontFace)
  );
}

/**
 * Які грані завантажити: лише стиль normal і сімейства з ролей h1/h2/body/button. Спершу для кожної
 * ролі — вага, найближча до її ваги на сайті; далі решта ваг тих самих сімейств (ближчі до 400/700
 * першими), по черзі між сімействами. Не більше `max` файлів.
 */
export function selectFontFiles(
  faces: readonly SiteFontFace[],
  fonts: DesignStats["fonts"],
  max: number = FONT_LIMITS.maxFiles,
): SiteFontFace[] {
  const groups = new Map<string, SiteFontFace[]>();
  for (const f of faces) {
    if (f.style !== "normal") continue;
    const list = groups.get(groupKey(f)) ?? [];
    list.push(f);
    groups.set(groupKey(f), list);
  }
  const weightsOf = (family: string) =>
    [...groups.values()]
      .map((g) => g[0] as SiteFontFace)
      .filter((f) => fontKey(f.family) === family)
      .map((f) => f.weight);

  const families: string[] = [];
  const picked: SiteFontFace[] = [];
  const taken = new Set<string>();
  const take = (family: string, weight: number) => {
    const key = `${family}|${weight}`;
    const group = groups.get(key);
    if (!group || taken.has(key) || picked.length >= max) return;
    taken.add(key);
    picked.push(bestOf(group));
  };

  for (const f of fonts) {
    if (!DOWNLOAD_ROLES.has(f.role)) continue;
    const family = fontKey(f.family);
    const weights = weightsOf(family);
    if (weights.length === 0) continue;
    if (!families.includes(family)) families.push(family);
    const nearest = weights.reduce((best, w) =>
      Math.abs(w - f.weight) < Math.abs(best - f.weight) ? w : best,
    );
    take(family, nearest);
  }
  const distance = (w: number) => Math.min(Math.abs(w - 400), Math.abs(w - 700));
  const rest = families.map((family) =>
    weightsOf(family)
      .filter((w) => !taken.has(`${family}|${w}`))
      .sort((a, b) => distance(a) - distance(b) || a - b),
  );
  for (let i = 0; picked.length < max && rest.some((r) => r.length > i); i++) {
    families.forEach((family, k) => {
      const w = rest[k]?.[i];
      if (w !== undefined) take(family, w);
    });
  }
  return picked;
}

/** Формат за сигнатурою файлу (сервер міг віддати HTML-сторінку помилки замість шрифту). */
export function sniffFontFormat(data: Buffer): FontFormat | null {
  if (data.length < 12) return null;
  const sig = data.subarray(0, 4).toString("latin1");
  if (sig === "wOF2") return "woff2";
  if (sig === "wOFF") return "woff";
  if (sig === "OTTO") return "opentype";
  if (sig === "true" || data.readUInt32BE(0) === 0x00010000) return "truetype";
  return null;
}

export interface FontDownloadOptions {
  guard: UrlGuard;
  storage: Storage;
  projectId: string;
  /** Загальний дедлайн краулу (мс від епохи). */
  deadline: number;
  /** Сторінка, з якої прийшли шрифти (referer: частина CDN без нього відмовляє). */
  referer: string;
  logger: Logger;
  maxFiles?: number;
}

/**
 * Завантажує вибрані файли у `crawl/fonts/<fontKey>-<weight>.<ext>` і повертає всі грані:
 * завантажені — з `path`, решта — з `path: null`. Спершу грані використаних сімейств.
 */
export async function downloadFontFiles(
  faces: readonly SiteFontFace[],
  fonts: DesignStats["fonts"],
  opts: FontDownloadOptions,
): Promise<SiteFontFace[]> {
  const selected = selectFontFiles(faces, fonts, opts.maxFiles ?? FONT_LIMITS.maxFiles);
  const crawlDir = projectPaths(opts.projectId).crawlDir;
  const usedKeys = new Set<string>();
  const results = await mapPool(selected, 3, async (face) => {
    const left = opts.deadline - Date.now();
    if (left < 500) return null;
    try {
      const res = await safeFetch(opts.guard, face.url, {
        timeoutMs: Math.min(10_000, left),
        maxBytes: FONT_LIMITS.maxBytes,
        headers: { referer: opts.referer, origin: new URL(opts.referer).origin, accept: "*/*" },
      });
      if (res.status !== 200) return null;
      const format = sniffFontFormat(res.body);
      if (!format) {
        opts.logger.debug("не шрифт", { url: face.url });
        return null;
      }
      const name = `${fontFileKey(face.family)}-${face.weight}`;
      if (usedKeys.has(name)) return null;
      usedKeys.add(name);
      const path = `${crawlDir}/fonts/${name}.${FORMAT_EXT[format]}`;
      await opts.storage.write(path, res.body);
      return { face, format, path };
    } catch (err) {
      opts.logger.debug("шрифт не завантажився", { url: face.url, error: (err as Error).message });
      return null;
    }
  });
  const byFace = new Map(results.filter((r) => r !== null).map((r) => [r.face, r]));
  const used = new Set(fonts.filter((f) => DOWNLOAD_ROLES.has(f.role)).map((f) => fontKey(f.family)));
  return faces
    .map((face) => {
      const got = byFace.get(face);
      return got ? { ...face, format: got.format, path: got.path } : face;
    })
    .sort(
      (a, b) =>
        Number(b.path !== null) - Number(a.path !== null) ||
        Number(used.has(fontKey(b.family))) - Number(used.has(fontKey(a.family))),
    )
    .slice(0, FONT_LIMITS.maxFaces);
}
