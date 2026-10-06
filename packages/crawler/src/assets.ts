import { type Asset, AssetManifest, projectPaths, type Storage } from "@adc/shared";
import { computePhash, dominantColors, imageInfo, isDuplicateHash } from "./image.ts";

/** Максимум асетів сайту в маніфесті. */
export const MAX_SITE_ASSETS = 40;
/** Пріоритет фото клієнта: завжди вище за будь-який асет сайту. */
export const USER_PRIORITY = 100;

export type SiteAssetKind = "photo" | "logo" | "background" | "icon" | "og";

/** Кандидат на асет, знайдений на сторінці. */
export interface AssetCandidate {
  /** Адреса картинки або `inline-svg:<n>` для вбудованого SVG. */
  url: string;
  kind: SiteAssetKind;
  alt: string | null;
  context: string | null;
  pageUrl: string;
  /** 0 — головна. */
  pageIndex: number;
  /** Позиція на сторінці, px. */
  top: number;
  renderedWidth: number;
  renderedHeight: number;
  /** Розмітка вбудованого SVG. */
  svg: string | null;
}

export interface DownloadedCandidate {
  candidate: AssetCandidate;
  data: Buffer;
}

/** Мінімальна довша сторона (px), щоб асет мав сенс у відео. */
const MIN_SIDE: Record<SiteAssetKind, number> = { logo: 16, icon: 32, og: 200, photo: 300, background: 400 };

/** Пріоритет асета сайту (1…70): лого, далі фото з головної, фони, og, іконки. */
export function sitePriority(c: AssetCandidate, width: number, height: number): number {
  const home = c.pageIndex === 0;
  const sizeBonus = Math.min(8, Math.floor((width * height) / 250_000));
  const belowFold = c.top > 2700 ? 4 : 0;
  switch (c.kind) {
    case "logo":
      return 60;
    case "photo":
      return (home ? 42 : 32) + sizeBonus - belowFold + (c.alt ? 2 : 0);
    case "background":
      return (home ? 40 : 30) + sizeBonus - belowFold;
    case "og":
      return 26;
    case "icon":
      return 20;
  }
}

/** Прибирає з SVG скрипти й обробники подій (файли віддаються браузеру через /files). */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*(["'])/gi, "$1#$2");
}

interface Prepared {
  candidate: AssetCandidate;
  data: Buffer;
  mime: string;
  ext: string;
  width: number;
  height: number;
  phash: string | null;
  priority: number;
}

/**
 * Обробляє завантажені картинки: формат і розміри, фільтр дрібних, pHash-дедуп
 * (лишається найбільший варіант, атрибути — від пріоритетнішого), домінантні кольори.
 * Записує файли `crawl/assets/aNN.<ext>` і повертає записи маніфесту.
 */
export async function buildSiteAssets(
  items: DownloadedCandidate[],
  opts: { storage: Storage; projectId: string; maxAssets?: number },
): Promise<Asset[]> {
  const maxAssets = opts.maxAssets ?? MAX_SITE_ASSETS;
  const prepared: Prepared[] = [];
  for (const item of items) {
    let data = item.data;
    const looksSvg =
      item.candidate.svg !== null ||
      /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(data.subarray(0, 2048).toString("utf8"));
    if (looksSvg) data = Buffer.from(sanitizeSvg(data.toString("utf8")), "utf8");
    const info = await imageInfo(data);
    if (!info) continue;
    if (Math.max(info.width, info.height) < MIN_SIDE[item.candidate.kind]) continue;
    prepared.push({
      candidate: item.candidate,
      data,
      mime: info.mime,
      ext: info.ext,
      width: info.width,
      height: info.height,
      phash: await computePhash(data),
      priority: sitePriority(item.candidate, info.width, info.height),
    });
  }

  prepared.sort((a, b) => b.priority - a.priority || b.width * b.height - a.width * a.height);
  const kept: Prepared[] = [];
  for (const p of prepared) {
    const dup = kept.find((k) => isDuplicateHash(k.phash, p.phash));
    if (!dup) {
      kept.push(p);
      continue;
    }
    // Той самий кадр у більшому розмірі — беремо файл більшого, атрибути лишаємо.
    if (p.width * p.height > dup.width * dup.height * 1.2 && dup.ext !== "svg") {
      Object.assign(dup, {
        data: p.data,
        mime: p.mime,
        ext: p.ext,
        width: p.width,
        height: p.height,
        phash: p.phash,
      });
      dup.candidate = { ...dup.candidate, url: p.candidate.url };
    }
    if (!dup.candidate.alt && p.candidate.alt) dup.candidate = { ...dup.candidate, alt: p.candidate.alt };
    if (!dup.candidate.context && p.candidate.context)
      dup.candidate = { ...dup.candidate, context: p.candidate.context };
  }

  const paths = projectPaths(opts.projectId);
  const assets: Asset[] = [];
  for (const [i, p] of kept.slice(0, maxAssets).entries()) {
    const id = `a${String(i + 1).padStart(2, "0")}`;
    const key = paths.asset(`${id}.${p.ext}`);
    await opts.storage.write(key, p.data);
    const c = p.candidate;
    assets.push({
      id,
      kind: c.kind,
      source: "site",
      path: key,
      originUrl: c.url.startsWith("inline-svg:") ? null : c.url,
      pageUrl: c.pageUrl,
      mime: p.mime,
      bytes: p.data.length,
      width: p.width,
      height: p.height,
      phash: p.phash,
      dominantColors: await dominantColors(p.data),
      alt: c.alt,
      context: c.context,
      isLogoCandidate: c.kind === "logo" || c.kind === "icon" || c.kind === "og",
      priority: p.priority,
    });
  }
  return assets;
}

/** Читає маніфест асетів (порожній, якщо файлу ще немає). */
export async function readManifest(storage: Storage, projectId: string): Promise<AssetManifest> {
  const key = projectPaths(projectId).assets;
  if (!(await storage.exists(key))) return { assets: [], updatedAt: new Date().toISOString() };
  return storage.readJson(key, (v) => AssetManifest.parse(v));
}

/**
 * Записує маніфест: асети сайту замінюються новими, фото клієнта зберігаються.
 * Фото клієнта завжди йдуть першими (найвищий пріоритет).
 */
export async function writeManifest(
  storage: Storage,
  projectId: string,
  update: { site?: Asset[]; user?: Asset[] },
): Promise<AssetManifest> {
  const current = await readManifest(storage, projectId);
  const site = update.site ?? current.assets.filter((a) => a.source === "site");
  const user = update.user ?? current.assets.filter((a) => a.source === "user");
  const manifest = AssetManifest.parse({
    assets: [...user, ...site].sort((a, b) => b.priority - a.priority),
    updatedAt: new Date().toISOString(),
  });
  await storage.writeJson(projectPaths(projectId).assets, manifest);
  return manifest;
}
