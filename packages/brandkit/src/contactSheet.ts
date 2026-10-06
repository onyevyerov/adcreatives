import type { Asset, Storage } from "@adc/shared";
import sharp, { type OverlayOptions } from "sharp";

/**
 * Контакт-лист асетів: одна картинка з мініатюрами в сітці й номерами.
 * Модель бачить усі асети одним image block (≈ до 1600×1600 px, ≤ ~3300 токенів),
 * а легенда «номер → assetId» іде текстом.
 */

export interface ContactSheetOptions {
  /** Розмір клітинки з мініатюрою, px (дефолт 180). */
  cell?: number;
  /** Максимум колонок (дефолт 8). */
  maxColumns?: number;
  /** Максимум асетів на аркуші (дефолт 48). */
  maxAssets?: number;
}

export interface ContactSheetCell {
  /** Номер на аркуші, з 1. */
  n: number;
  assetId: string;
  /** false — файл не прочитався, у клітинці заглушка. */
  ok: boolean;
}

export interface ContactSheet {
  png: Buffer;
  width: number;
  height: number;
  columns: number;
  rows: number;
  cells: ContactSheetCell[];
}

const GAP = 8;
const LABEL_H = 26;
/** Сіре тло клітинки: на ньому видно і біле, і темне лого з прозорістю. */
const CELL_BG = { r: 160, g: 160, b: 160, alpha: 1 };
const SHEET_BG = { r: 255, g: 255, b: 255, alpha: 1 };

/** Порядок на аркуші: фото клієнта і пріоритетні асети першими, далі за id. */
export function orderAssets(assets: readonly Asset[]): Asset[] {
  return [...assets].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

function labelSvg(width: number, text: string): Buffer {
  const safe = text.replace(/[<>&"']/g, "");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_H}">` +
      `<rect width="100%" height="100%" fill="#111111"/>` +
      `<text x="8" y="${LABEL_H - 8}" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" ` +
      `font-weight="bold" fill="#FFFFFF">${safe}</text></svg>`,
  );
}

function placeholderSvg(size: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="100%" height="100%" fill="#d0d0d0"/>` +
      `<line x1="0" y1="0" x2="${size}" y2="${size}" stroke="#888" stroke-width="3"/>` +
      `<line x1="${size}" y1="0" x2="0" y2="${size}" stroke="#888" stroke-width="3"/></svg>`,
  );
}

async function thumbnail(data: Buffer, size: number): Promise<Buffer> {
  return sharp(data, { failOn: "none", density: 144 })
    .rotate()
    .resize(size, size, { fit: "contain", background: CELL_BG })
    .flatten({ background: CELL_BG })
    .png()
    .toBuffer();
}

/** Будує контакт-лист із файлів асетів у сховищі. Порожній список — помилка. */
export async function buildContactSheet(
  storage: Pick<Storage, "read">,
  assets: readonly Asset[],
  opts: ContactSheetOptions = {},
): Promise<ContactSheet> {
  const size = opts.cell ?? 180;
  const maxAssets = opts.maxAssets ?? 48;
  const list = orderAssets(assets).slice(0, maxAssets);
  if (list.length === 0) throw new Error("buildContactSheet: немає асетів");

  const columns = Math.min(opts.maxColumns ?? 8, Math.max(1, Math.ceil(Math.sqrt(list.length))));
  const rows = Math.ceil(list.length / columns);
  const cellW = size;
  const cellH = size + LABEL_H;
  const width = GAP + columns * (cellW + GAP);
  const height = GAP + rows * (cellH + GAP);

  const cells: ContactSheetCell[] = [];
  const layers: OverlayOptions[] = [];
  for (const [i, asset] of list.entries()) {
    const n = i + 1;
    const left = GAP + (i % columns) * (cellW + GAP);
    const top = GAP + Math.floor(i / columns) * (cellH + GAP);
    let img: Buffer;
    let ok = true;
    try {
      img = await thumbnail(await storage.read(asset.path), size);
    } catch {
      ok = false;
      img = await sharp(placeholderSvg(size)).png().toBuffer();
    }
    cells.push({ n, assetId: asset.id, ok });
    layers.push({ input: img, left, top });
    layers.push({ input: labelSvg(cellW, `${n} · ${asset.id}`), left, top: top + size });
  }

  const png = await sharp({ create: { width, height, channels: 4, background: SHEET_BG } })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { png, width, height, columns, rows, cells };
}

/** Легенда для промпта: номер на аркуші → метадані асета. */
export function contactSheetLegend(sheet: ContactSheet, assets: readonly Asset[]) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  return sheet.cells.map(({ n, assetId, ok }) => {
    const a = byId.get(assetId);
    return {
      n,
      assetId,
      kind: a?.kind ?? null,
      source: a?.source ?? null,
      size: a ? `${a.width}×${a.height}` : null,
      alt: a?.alt ?? null,
      context: a?.context ? a.context.slice(0, 160) : null,
      isLogoCandidate: a?.isLogoCandidate ?? false,
      dominantColors: a?.dominantColors.slice(0, 4) ?? [],
      ...(ok ? {} : { unreadable: true }),
    };
  });
}

/**
 * Зменшує скриншот для image block: JPEG, довша сторона ≤ maxSide (дефолт 1440).
 * Токени зображення ≈ ⌈w/28⌉×⌈h/28⌉, тож 1440×900 ≈ 1700 токенів.
 */
export async function prepareScreenshot(data: Buffer, maxSide = 1440): Promise<Buffer> {
  return sharp(data, { failOn: "none" })
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}
