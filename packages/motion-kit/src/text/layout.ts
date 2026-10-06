/**
 * Розкладка тексту без DOM: розбиття на слова, перенос по ширині, підбір розміру шрифту.
 * Ширини слів дає `Measurer` (у браузері — `measureText` з `@remotion/layout-utils`,
 * у тестах — фейковий вимірювач), тому логіка детермінована й тестується в Node.
 */

/** Ширина тексту в px для розміру шрифту `fontSize`. */
export type Measurer = (text: string, fontSize: number) => number;

/** Запас ширини: браузер переносить трохи інакше, ніж сума ширин слів. */
export const WIDTH_SAFETY = 0.97;

export function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Жадібний перенос слів у рядки шириною ≤ maxWidth. Слово, ширше за рядок, займає рядок саме. */
export function wrapWords(
  words: readonly string[],
  maxWidth: number,
  fontSize: number,
  measure: Measurer,
): string[][] {
  const lines: string[][] = [];
  const space = measure(" ", fontSize);
  let current: string[] = [];
  let currentWidth = 0;
  for (const word of words) {
    const w = measure(word, fontSize);
    if (current.length === 0) {
      current = [word];
      currentWidth = w;
      continue;
    }
    if (currentWidth + space + w <= maxWidth) {
      current.push(word);
      currentWidth += space + w;
    } else {
      lines.push(current);
      current = [word];
      currentWidth = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export interface FitInput {
  text: string;
  maxLines: number;
  width: number;
  maxFontSize: number;
  minFontSize: number;
  measure: Measurer;
}

export interface FitResult {
  /** Розмір, яким малюємо (між minFontSize і maxFontSize). */
  fontSize: number;
  /** Слова по рядках для цього розміру. */
  lines: string[][];
  /** Найбільший розмір, з яким текст влазить (може бути < minFontSize). */
  idealFontSize: number;
  /** Довелося обмежити розмір мінімумом. */
  hitMin: boolean;
  /** Навіть на мінімумі текст не влазить у maxLines рядків / ширину. */
  overflow: boolean;
  /** Ширина найдовшого рядка, px. */
  widestLine: number;
}

function layoutFits(
  words: readonly string[],
  input: FitInput,
  fontSize: number,
): { fits: boolean; lines: string[][]; widest: number } {
  const maxWidth = input.width * WIDTH_SAFETY;
  const lines = wrapWords(words, maxWidth, fontSize, input.measure);
  const widest = Math.max(0, ...lines.map((l) => input.measure(l.join(" "), fontSize)));
  return { fits: lines.length <= input.maxLines && widest <= maxWidth, lines, widest };
}

/** Найбільший розмір шрифту ≤ maxFontSize, з яким текст влазить у maxLines рядків ширини width. */
export function fitText(input: FitInput): FitResult {
  const words = splitWords(input.text);
  const maxLines = Math.max(1, Math.floor(input.maxLines));
  const min = Math.max(1, Math.min(input.minFontSize, input.maxFontSize));
  const max = Math.max(min, input.maxFontSize);
  const normalized = { ...input, maxLines };
  if (words.length === 0) {
    return { fontSize: max, lines: [], idealFontSize: max, hitMin: false, overflow: false, widestLine: 0 };
  }
  const atMax = layoutFits(words, normalized, max);
  if (atMax.fits) {
    return {
      fontSize: max,
      lines: atMax.lines,
      idealFontSize: max,
      hitMin: false,
      overflow: false,
      widestLine: atMax.widest,
    };
  }
  // Бінарний пошук по цілих px у [1, max).
  let lo = 1;
  let hi = max;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (layoutFits(words, normalized, mid).fits) lo = mid;
    else hi = mid;
  }
  const ideal = layoutFits(words, normalized, lo).fits ? lo : 0;
  if (ideal >= min) {
    const res = layoutFits(words, normalized, ideal);
    return {
      fontSize: ideal,
      lines: res.lines,
      idealFontSize: ideal,
      hitMin: ideal === min,
      overflow: false,
      widestLine: res.widest,
    };
  }
  const atMin = layoutFits(words, normalized, min);
  return {
    fontSize: min,
    lines: atMin.lines,
    idealFontSize: ideal,
    hitMin: true,
    overflow: !atMin.fits,
    widestLine: atMin.widest,
  };
}

/** Нормалізація слова для порівняння з emphasis: регістр і пунктуація по краях. */
export function normalizeWord(word: string): string {
  return word.toLocaleLowerCase().replace(/^[^\p{L}\p{N}%+\-$€₴]+|[^\p{L}\p{N}%$€₴]+$/gu, "");
}

/**
 * Позначає слова, що входять у фрази emphasis (фраза з кількох слів — послідовність).
 * Повертає масив прапорців паралельно `words`.
 */
export function markEmphasis(words: readonly string[], emphasis: readonly string[] | undefined): boolean[] {
  const flags = words.map(() => false);
  if (!emphasis || emphasis.length === 0) return flags;
  // Слова без літер і цифр (тире тощо) не беруть участі в порівнянні фраз.
  const indexed = words.map((w, i) => ({ n: normalizeWord(w), i })).filter((x) => x.n !== "");
  for (const phrase of emphasis) {
    const parts = splitWords(phrase).map(normalizeWord).filter(Boolean);
    if (parts.length === 0) continue;
    for (let k = 0; k + parts.length <= indexed.length; k++) {
      if (!parts.every((p, j) => indexed[k + j]?.n === p)) continue;
      for (let j = 0; j < parts.length; j++) {
        const at = indexed[k + j];
        if (at) flags[at.i] = true;
      }
    }
  }
  return flags;
}

/** Приблизний вимірювач для Node/тестів: середня ширина символу 0.56 em, пробіл 0.28 em. */
export const approxMeasurer: Measurer = (text, fontSize) => {
  let w = 0;
  for (const ch of text)
    w += ch === " " ? 0.28 : /[ШЩЖМWMЮ@]/u.test(ch) ? 0.85 : /[ilI.,:;'!|ї]/u.test(ch) ? 0.3 : 0.56;
  return w * fontSize;
};
