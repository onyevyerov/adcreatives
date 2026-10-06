import { measureText } from "@remotion/layout-utils";
import { approxMeasurer, type Measurer } from "./layout.ts";

/** Розмір, на якому міряємо; ширина тексту масштабується лінійно. */
const REFERENCE_SIZE = 100;

/**
 * Вимірювач на основі `measureText` (DOM). Слова міряються один раз на опорному розмірі
 * (кеш усередині layout-utils), тож бінарний пошук розміру шрифту дешевий.
 * Поза браузером — приблизний вимірювач.
 */
export function createMeasurer(fontFamily: string, fontWeight: number, letterSpacingEm = 0): Measurer {
  if (typeof document === "undefined") return approxMeasurer;
  const cache = new Map<string, number>();
  return (text, fontSize) => {
    let w = cache.get(text);
    if (w === undefined) {
      w = measureText({
        text,
        fontFamily,
        fontWeight,
        fontSize: REFERENCE_SIZE,
        ...(letterSpacingEm ? { letterSpacing: `${letterSpacingEm}em` } : {}),
      }).width;
      cache.set(text, w);
    }
    return (w * fontSize) / REFERENCE_SIZE;
  };
}
