/**
 * Числа в текстах сцени: перше число рядка (для графіків і лічильника) і «одометр» —
 * проміжне значення, записане символ у символ на місці кінцевого числа.
 * Чисті функції — працюють і в браузері, і в Node.
 */

/** Число, знайдене в тексті. */
export interface NumberMatch {
  value: number;
  /** Індекс першого символу числа в тексті. */
  start: number;
  /** Індекс після останнього символу. */
  end: number;
  /** Цифр після десяткового розділювача. */
  decimals: number;
}

// Цифри; далі групи по три через пробіл (звичайний, нерозривний, вузький), кому, крапку чи апостроф;
// далі необов'язкова дробова частина через кому чи крапку.
const NUMBER_RE = /(\d+)((?:[    ,.'’]\d{3}(?!\d))*)(?:[.,](\d+))?/;

/**
 * Перше число в тексті, без знака. «1 200», «1,200», «1.200» — тисяча двісті; «4,9» і «4.9» — 4.9;
 * «0.125» — дріб. Немає цифр → null.
 */
export function findNumber(text: string): NumberMatch | null {
  const m = NUMBER_RE.exec(text);
  if (!m) return null;
  const head = m[1] ?? "";
  let groups = m[2] ?? "";
  let fraction = m[3];
  // «0.125»: одна «група» після нуля — це дріб, а не тисячі.
  if (fraction === undefined && head === "0" && /^[.,]\d{3}$/.test(groups)) {
    fraction = groups.slice(1);
    groups = "";
  }
  const intDigits = (head + groups).replace(/\D/g, "");
  const value = Number(fraction !== undefined ? `${intDigits}.${fraction}` : intDigits);
  return { value, start: m.index, end: m.index + m[0].length, decimals: fraction?.length ?? 0 };
}

/** Перше число в тексті: `"~50 перевірок"` → 50, `"від $300–2000"` → 300, без цифр → null. */
export function numberIn(text: string): number | null {
  return findNumber(text)?.value ?? null;
}

/** Символ числа-одометра: цифра чи розділювач на місці символу кінцевого числа. */
export interface OdometerChar {
  ch: string;
  /** Провідний нуль чи розділювач перед ним: тримає місце, але невидимий. */
  hidden: boolean;
}

/**
 * Значення `value` (0 ≤ value ≤ кінцеве), записане у форму кінцевого числа `final` (рядок із тексту):
 * стільки ж символів, ті самі розділювачі на тих самих місцях, зайві провідні цифри — приховані
 * нулі. Тож розкладка тексту не змінюється, поки лічильник біжить.
 */
export function odometer(final: string, value: number, decimals: number): OdometerChar[] {
  const slots = [...final].filter((c) => /\d/.test(c)).length;
  const digits = Math.max(0, value).toFixed(decimals).replace(/\D/g, "").padStart(slots, "0").slice(-slots);
  // Остання цифра цілої частини завжди видима (0, а не порожнеча).
  const unitsSlot = Math.max(0, slots - decimals - 1);
  let firstShown = digits.search(/[1-9]/);
  if (firstShown < 0 || firstShown > unitsSlot) firstShown = unitsSlot;
  const out: OdometerChar[] = [];
  let slot = 0;
  for (const c of final) {
    if (/\d/.test(c)) {
      out.push({ ch: digits.charAt(slot), hidden: slot < firstShown });
      slot++;
    } else {
      // Розділювач видно, лише якщо зліва від нього вже є видима цифра.
      out.push({ ch: c, hidden: slot <= firstShown });
    }
  }
  return out;
}
