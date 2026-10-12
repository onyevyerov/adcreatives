import { type FontInfo, monoChoice, pruneFontInfo } from "@adc/motion-kit";
import type { BrandKit } from "@adc/shared/schemas/brandkit";
import { getAvailableFonts } from "@remotion/google-fonts";

/**
 * Метадані Google Fonts для шрифтів бренду (на боці Node). Передаються в inputProps як `fonts`,
 * щоб бандл не містив ~1800 модулів `@remotion/google-fonts`.
 */

const cache = new Map<string, Promise<FontInfo | null>>();

async function loadInfo(family: string): Promise<FontInfo | null> {
  const entry = getAvailableFonts().find((f) => f.fontFamily.toLowerCase() === family.toLowerCase());
  if (!entry) return null;
  const mod = (await entry.load()) as { getInfo: () => FontInfo };
  return mod.getInfo();
}

export function fontInfoFor(family: string): Promise<FontInfo | null> {
  let p = cache.get(family);
  if (!p) {
    p = loadInfo(family).catch(() => null);
    cache.set(family, p);
  }
  return p;
}

/**
 * FontInfo для heading, body і mono бренду (обрізані до потрібних ваг; невідомі сімейства пропускаються).
 * mono без вибору бренд-кіта — `JetBrains Mono` (як у темі motion-kit).
 */
export async function resolveBrandFonts(brand: BrandKit): Promise<FontInfo[]> {
  const wanted = [brand.typography.heading, brand.typography.body, monoChoice(brand.typography)];
  const out: FontInfo[] = [];
  for (const choice of wanted) {
    const info = await fontInfoFor(choice.family);
    if (!info) continue;
    // heading, body і mono можуть бути одним сімейством — зливаємо ваги.
    const weights = wanted.filter((w) => w.family === choice.family).flatMap((w) => w.weights);
    if (out.some((o) => o.fontFamily === info.fontFamily)) continue;
    out.push(pruneFontInfo(info, weights));
  }
  return out;
}
