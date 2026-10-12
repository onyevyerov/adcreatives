import { FORMAT_SIZE, type Format, STILL_PLAN, type StillVariant } from "@adc/shared";
import sharp, { type OverlayOptions } from "sharp";

/**
 * Зображення зі стілів сцен.
 *
 * - Зведений аркуш формату (`sheets/<format>.png`) — для людини: стіли всіх сцен однією картинкою,
 *   колонка на сцену, рядки за `STILL_PLAN` (e — 25%, a — 50%, b — 90%), підписи під кадрами.
 *   Ширина аркуша ≤ ~2400 px; зайві сцени — новим рядом.
 * - Зображення сцени для QA (`buildSceneImage`) — кадри e/a/b однієї сцени в одному форматі:
 *   9:16 і 1:1 у ряд, 16:9 у стовпчик; довша сторона ≤ `QA_IMAGE_MAX_SIDE`. Запасний варіант,
 *   коли аркуша стрічки немає (check.json до появи стрічки).
 * - Аркуш стрічки сцени (`buildStripSheet`, `strips/<format>/<sceneId>.jpg`) — кадри сцени кожні
 *   0.5 с (`stripFrames`) сіткою в межах `QA_IMAGE_MAX_SIDE`; його бачать арт-директор (qa) і fix.
 * - Мініатюри для різниці кадрів (`diffThumb`) — сирі пікселі кадру стрічки, зменшеного до
 *   `STRIP_DIFF_WIDTH` по ширині (автодетектор `static_hold`).
 */

export interface SheetCell {
  sceneId: string;
  variant: StillVariant;
  /** PNG стілу; null — кадру немає (помилка або сцену не перевірено). */
  png: Buffer | null;
  label: string;
  /** Текст заглушки, якщо png = null. */
  note?: string;
}

/**
 * Ліміт довшої сторони зображення для vision. Документація Anthropic радить ≤ 1568 px: більші
 * зображення API однаково зменшує (довше відповідає й нічого не додає до деталей).
 */
export const QA_IMAGE_MAX_SIDE = 1568;

const GAP = 8;
const LABEL_H = 28;
const MAX_WIDTH = 2400;
const BG = { r: 255, g: 255, b: 255, alpha: 1 };

/** Розмір мініатюри кадру для формату (аркуш для людини). */
export function thumbSize(format: Format): { width: number; height: number } {
  const { width, height } = FORMAT_SIZE[format];
  const longSide = format === "square" ? 360 : 480;
  const k = longSide / Math.max(width, height);
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string,
  );
}

function labelSvg(width: number, text: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_H}">` +
      `<rect width="100%" height="100%" fill="#111111"/>` +
      `<text x="8" y="${LABEL_H - 9}" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" ` +
      `font-weight="bold" fill="#FFFFFF">${escapeXml(text)}</text></svg>`,
  );
}

function placeholderSvg(width: number, height: number, note: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="#d9d9d9"/>` +
      `<line x1="0" y1="0" x2="${width}" y2="${height}" stroke="#b0b0b0" stroke-width="3"/>` +
      `<line x1="${width}" y1="0" x2="0" y2="${height}" stroke="#b0b0b0" stroke-width="3"/>` +
      `<text x="50%" y="50%" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" ` +
      `font-size="22" fill="#B00020">${escapeXml(note)}</text></svg>`,
  );
}

/** Кадр клітинки (або сіра перекреслена заглушка) + підпис під ним, з лівим верхнім кутом у (left, top). */
async function cellLayers(
  cell: Pick<SheetCell, "png" | "label" | "note"> | undefined,
  fallbackLabel: string,
  size: { width: number; height: number },
  left: number,
  top: number,
): Promise<OverlayOptions[]> {
  let img: Buffer;
  try {
    img = cell?.png
      ? await sharp(cell.png).resize(size.width, size.height, { fit: "fill" }).png().toBuffer()
      : await sharp(placeholderSvg(size.width, size.height, cell?.note ?? "немає кадру"))
          .png()
          .toBuffer();
  } catch {
    img = await sharp(placeholderSvg(size.width, size.height, "кадр пошкоджено"))
      .png()
      .toBuffer();
  }
  return [
    { input: img, left, top },
    { input: labelSvg(size.width, cell?.label ?? fallbackLabel), left, top: top + size.height },
  ];
}

/** Будує аркуш із клітинок у порядку сцен (на сцену клітинка на кожен варіант `STILL_PLAN`). */
export async function buildSheet(format: Format, cells: readonly SheetCell[]): Promise<Buffer> {
  const thumb = thumbSize(format);
  const rows = STILL_PLAN.length;
  const sceneIds = [...new Set(cells.map((c) => c.sceneId))];
  const columns = Math.max(1, Math.min(sceneIds.length, Math.floor((MAX_WIDTH - GAP) / (thumb.width + GAP))));
  const bands = Math.ceil(sceneIds.length / columns);
  const cellH = thumb.height + LABEL_H;
  const width = GAP + columns * (thumb.width + GAP);
  const height = GAP + bands * rows * (cellH + GAP);

  const layers: OverlayOptions[] = [];
  for (const [i, sceneId] of sceneIds.entries()) {
    const col = i % columns;
    const band = Math.floor(i / columns);
    for (const [row, { variant }] of STILL_PLAN.entries()) {
      const cell = cells.find((c) => c.sceneId === sceneId && c.variant === variant);
      const left = GAP + col * (thumb.width + GAP);
      const top = GAP + (band * rows + row) * (cellH + GAP);
      layers.push(...(await cellLayers(cell, `${sceneId} · ${variant}`, thumb, left, top)));
    }
  }
  return sharp({ create: { width, height, channels: 4, background: BG } })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Розкладка зображення сцени для QA: кадри у ряд (9:16, 1:1) чи стовпчиком (16:9) у межах maxSide. */
export function sceneImageLayout(
  format: Format,
  maxSide = QA_IMAGE_MAX_SIDE,
): { inRow: boolean; frame: { width: number; height: number }; width: number; height: number } {
  const full = FORMAT_SIZE[format];
  const aspect = full.width / full.height;
  const n = STILL_PLAN.length;
  const inRow = format !== "landscape";
  // Межі кадру по ширині й висоті з урахуванням проміжків і підписів; без збільшення понад оригінал.
  const maxW = Math.min(full.width, inRow ? (maxSide - GAP * (n + 1)) / n : maxSide - 2 * GAP);
  const maxH = Math.min(
    full.height,
    inRow ? maxSide - 2 * GAP - LABEL_H : (maxSide - GAP - n * (LABEL_H + GAP)) / n,
  );
  const w = Math.floor(Math.min(maxW, maxH * aspect));
  const frame = { width: w, height: Math.floor(w / aspect) };
  const cellH = frame.height + LABEL_H;
  return inRow
    ? { inRow, frame, width: GAP + n * (frame.width + GAP), height: GAP + cellH + GAP }
    : { inRow, frame, width: GAP + frame.width + GAP, height: GAP + n * (cellH + GAP) };
}

/** Зображення однієї сцени в одному форматі для QA: кадри в порядку `STILL_PLAN`, PNG. */
export async function buildSceneImage(
  format: Format,
  cells: readonly SheetCell[],
  maxSide = QA_IMAGE_MAX_SIDE,
): Promise<Buffer> {
  const layout = sceneImageLayout(format, maxSide);
  const { frame } = layout;
  const layers: OverlayOptions[] = [];
  for (const [i, { variant }] of STILL_PLAN.entries()) {
    const cell = cells.find((c) => c.variant === variant);
    const left = layout.inRow ? GAP + i * (frame.width + GAP) : GAP;
    const top = layout.inRow ? GAP : GAP + i * (frame.height + LABEL_H + GAP);
    layers.push(...(await cellLayers(cell, variant, frame, left, top)));
  }
  return sharp({ create: { width: layout.width, height: layout.height, channels: 4, background: BG } })
    .composite(layers)
    .png()
    .toBuffer();
}

/** Клітинка аркуша стрічки: кадр сцени і підпис. */
export interface StripCell {
  frame: number;
  /** PNG кадру; null — кадр не відрендерився (сіра заглушка з `note`). */
  png: Buffer | null;
  label: string;
  note?: string;
}

/** Розкладка аркуша стрічки: сітка `columns × rows` найбільших кадрів, що вміщаються в maxSide. */
export function stripSheetLayout(
  format: Format,
  count: number,
  maxSide = QA_IMAGE_MAX_SIDE,
): {
  columns: number;
  rows: number;
  frame: { width: number; height: number };
  width: number;
  height: number;
} {
  const full = FORMAT_SIZE[format];
  const aspect = full.width / full.height;
  const n = Math.max(1, count);
  let best = { columns: 1, rows: n, w: 0 };
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    const maxW = (maxSide - GAP * (columns + 1)) / columns;
    const maxH = (maxSide - GAP * (rows + 1)) / rows - LABEL_H;
    const w = Math.floor(Math.min(full.width, maxW, maxH * aspect));
    if (w > best.w) best = { columns, rows, w };
  }
  const w = Math.max(1, best.w);
  const frame = { width: w, height: Math.max(1, Math.floor(w / aspect)) };
  return {
    columns: best.columns,
    rows: best.rows,
    frame,
    width: GAP + best.columns * (frame.width + GAP),
    height: GAP + best.rows * (frame.height + LABEL_H + GAP),
  };
}

/** Аркуш стрічки однієї сцени в одному форматі: кадри в порядку `cells` зліва направо, рядами; JPEG. */
export async function buildStripSheet(
  format: Format,
  cells: readonly StripCell[],
  maxSide = QA_IMAGE_MAX_SIDE,
): Promise<Buffer> {
  const layout = stripSheetLayout(format, cells.length, maxSide);
  const { frame } = layout;
  const layers: OverlayOptions[] = [];
  for (const [i, cell] of cells.entries()) {
    const left = GAP + (i % layout.columns) * (frame.width + GAP);
    const top = GAP + Math.floor(i / layout.columns) * (frame.height + LABEL_H + GAP);
    layers.push(...(await cellLayers(cell, cell.label, frame, left, top)));
  }
  return sharp({ create: { width: layout.width, height: layout.height, channels: 3, background: BG } })
    .composite(layers)
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Ширина мініатюри кадру стрічки для різниці сусідніх кадрів (`static_hold`). */
export const STRIP_DIFF_WIDTH = 96;

/** Сирі RGB-пікселі кадру, зменшеного до `STRIP_DIFF_WIDTH` по ширині (висота — за пропорціями формату). */
export async function diffThumb(png: Buffer, format: Format): Promise<Buffer> {
  const { width, height } = FORMAT_SIZE[format];
  const h = Math.max(1, Math.round((STRIP_DIFF_WIDTH * height) / width));
  return sharp(png)
    .resize(STRIP_DIFF_WIDTH, h, { fit: "fill" })
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw()
    .toBuffer();
}
