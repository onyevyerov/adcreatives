import sharp from "sharp";

/** Обмеження sharp на розмір вхідного зображення (пікселі) — захист від «бомб». */
export const MAX_INPUT_PIXELS = 100_000_000;

const sharpOf = (data: Buffer) => sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" });

export interface ImageInfo {
  format: string;
  mime: string;
  ext: string;
  width: number;
  height: number;
}

const FORMATS: Record<string, { mime: string; ext: string }> = {
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  png: { mime: "image/png", ext: "png" },
  webp: { mime: "image/webp", ext: "webp" },
  gif: { mime: "image/gif", ext: "gif" },
  svg: { mime: "image/svg+xml", ext: "svg" },
  avif: { mime: "image/avif", ext: "avif" },
  heif: { mime: "image/avif", ext: "avif" },
};

/** Формат і розміри (з урахуванням EXIF-повороту). null — не зображення. */
export async function imageInfo(data: Buffer): Promise<ImageInfo | null> {
  try {
    const meta = await sharpOf(data).metadata();
    const f = meta.format ? FORMATS[meta.format] : undefined;
    if (!f || !meta.width || !meta.height) return null;
    const rotated = (meta.orientation ?? 1) >= 5;
    return {
      format: meta.format as string,
      ...f,
      width: rotated ? meta.height : meta.width,
      height: rotated ? meta.width : meta.height,
    };
  } catch {
    return null;
  }
}

/** Таблиця косинусів для DCT 32×32. */
const N = 32;
const COS: number[][] = Array.from({ length: N }, (_, k) =>
  Array.from({ length: N }, (_, n) => Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N))),
);

/**
 * Перцептивний хеш (pHash, 64 біти → 16 hex): DCT зменшеної до 32×32 сірої копії,
 * верхній лівий блок 8×8 порівнюється з медіаною.
 */
export async function computePhash(data: Buffer): Promise<string | null> {
  let pixels: Buffer;
  try {
    pixels = await sharpOf(data)
      .rotate()
      .flatten({ background: "#ffffff" })
      .greyscale()
      .resize(N, N, { fit: "fill" })
      .raw()
      .toBuffer();
  } catch {
    return null;
  }
  if (pixels.length < N * N) return null;
  // Рядки, потім стовпці (лише перші 8 коефіцієнтів).
  const rows: number[][] = [];
  for (let y = 0; y < N; y++) {
    const row: number[] = [];
    for (let k = 0; k < 8; k++) {
      let sum = 0;
      const cos = COS[k] as number[];
      for (let x = 0; x < N; x++) sum += (pixels[y * N + x] as number) * (cos[x] as number);
      row.push(sum);
    }
    rows.push(row);
  }
  const coeffs: number[] = [];
  for (let ky = 0; ky < 8; ky++) {
    const cos = COS[ky] as number[];
    for (let kx = 0; kx < 8; kx++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += ((rows[y] as number[])[kx] as number) * (cos[y] as number);
      coeffs.push(sum);
    }
  }
  const sorted = coeffs.slice(1).sort((a, b) => a - b);
  const median = ((sorted[31] as number) + (sorted[32] as number)) / 2;
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) nibble = (nibble << 1) | ((coeffs[i + b] as number) > median ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

/** Відстань Геммінга між двома pHash у hex. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = Number.parseInt(a[i] as string, 16) ^ Number.parseInt(b[i] as string, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Поріг дублікату: однакова картинка в різних розмірах/стисненні дає ≤ 6 біт різниці. */
export const PHASH_DUPLICATE_DISTANCE = 6;

export function isDuplicateHash(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && hammingDistance(a, b) <= PHASH_DUPLICATE_DISTANCE;
}

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** До `max` домінантних кольорів (#RRGGBB), прозорі пікселі не враховуються. */
export async function dominantColors(data: Buffer, max = 5): Promise<string[]> {
  let raw: Buffer;
  try {
    raw = await sharpOf(data).rotate().resize(64, 64, { fit: "inside" }).ensureAlpha().raw().toBuffer();
  } catch {
    return [];
  }
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let i = 0; i + 3 < raw.length; i += 4) {
    if ((raw[i + 3] as number) < 128) continue;
    const r = raw[i] as number;
    const g = raw[i + 1] as number;
    const b = raw[i + 2] as number;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
    total++;
  }
  if (total === 0) return [];
  const picked: Array<{ r: number; g: number; b: number }> = [];
  for (const bucket of [...buckets.values()].sort((a, b) => b.n - a.n)) {
    if (picked.length >= max || bucket.n / total < 0.03) break;
    const c = { r: bucket.r / bucket.n, g: bucket.g / bucket.n, b: bucket.b / bucket.n };
    const close = picked.some((p) => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) < 40);
    if (!close) picked.push(c);
  }
  return picked.map((c) => toHex(c.r, c.g, c.b));
}

export { sharpOf };
