import type { BrandKit } from "./schemas/brandkit.ts";
import type { Scene } from "./schemas/storyboard.ts";

/**
 * Точні рядки, які дозволено показати в кадрі сцени: headline, sub, `items[].text`, `brand.cta.text`.
 * Єдине джерело для промптів codegen/fix і для `guardScene({ allowedTexts })`.
 */
export function allowedScreenTexts(
  scene: Pick<Scene, "text" | "items">,
  brand: Pick<BrandKit, "cta">,
): string[] {
  const out = [scene.text.headline, scene.text.sub ?? "", ...scene.items.map((i) => i.text), brand.cta.text];
  return [...new Set(out.filter((s) => s.trim().length > 0))];
}
