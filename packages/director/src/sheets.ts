import { FORMAT_SIZE, type Format } from "@adc/shared";
import sharp, { type OverlayOptions } from "sharp";

/**
 * Зведений аркуш формату (`sheets/<format>.png`): стіли всіх сцен однією картинкою —
 * колонка на сцену, зверху кадр «a» (50%), знизу «b» (90%), підписи під кадрами.
 * Ширина аркуша ≤ ~2400 px (ліміт image block 2576 px по довшій стороні); зайві сцени — новим рядом.
 */

export interface SheetCell {
  sceneId: string;
  variant: "a" | "b";
  /** PNG стілу; null — кадру немає (помилка або сцену не перевірено). */
  png: Buffer | null;
  label: string;
  /** Текст заглушки, якщо png = null. */
  note?: string;
}

const GAP = 8;
const LABEL_H = 28;
const MAX_WIDTH = 2400;
const BG = { r: 255, g: 255, b: 255, alpha: 1 };

/** Розмір мініатюри кадру для формату. */
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

/** Будує аркуш із клітинок у порядку сцен (на сцену дві клітинки: a, b). */
export async function buildSheet(format: Format, cells: readonly SheetCell[]): Promise<Buffer> {
  const thumb = thumbSize(format);
  const sceneIds = [...new Set(cells.map((c) => c.sceneId))];
  const columns = Math.max(1, Math.min(sceneIds.length, Math.floor((MAX_WIDTH - GAP) / (thumb.width + GAP))));
  const bands = Math.ceil(sceneIds.length / columns);
  const cellH = thumb.height + LABEL_H;
  const width = GAP + columns * (thumb.width + GAP);
  const height = GAP + bands * 2 * (cellH + GAP);

  const layers: OverlayOptions[] = [];
  for (const [i, sceneId] of sceneIds.entries()) {
    const col = i % columns;
    const band = Math.floor(i / columns);
    for (const variant of ["a", "b"] as const) {
      const cell = cells.find((c) => c.sceneId === sceneId && c.variant === variant);
      const left = GAP + col * (thumb.width + GAP);
      const top = GAP + (band * 2 + (variant === "a" ? 0 : 1)) * (cellH + GAP);
      let img: Buffer;
      try {
        img = cell?.png
          ? await sharp(cell.png).resize(thumb.width, thumb.height, { fit: "fill" }).png().toBuffer()
          : await sharp(placeholderSvg(thumb.width, thumb.height, cell?.note ?? "немає кадру"))
              .png()
              .toBuffer();
      } catch {
        img = await sharp(placeholderSvg(thumb.width, thumb.height, "кадр пошкоджено"))
          .png()
          .toBuffer();
      }
      layers.push({ input: img, left, top });
      layers.push({
        input: labelSvg(thumb.width, cell?.label ?? `${sceneId} · ${variant}`),
        left,
        top: top + thumb.height,
      });
    }
  }
  return sharp({ create: { width, height, channels: 4, background: BG } })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
}
