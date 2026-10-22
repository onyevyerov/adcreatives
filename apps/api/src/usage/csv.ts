import type { UsageCsvRow } from "./types.ts";

/** UTF-8 BOM: Excel інакше читає кирилицю як ANSI. */
export const CSV_BOM = String.fromCharCode(0xfeff);
/** Excel-дружній розділювач рядків. */
export const CSV_EOL = "\r\n";

/** Колонки `projects.csv` (`docs/usage-api.md`) і відповідні поля `UsageCsvRow` — у порядку файлу. */
export const CSV_COLUMNS = [
  ["owner_email", "ownerEmail"],
  ["project_id", "projectId"],
  ["host", "host"],
  ["status", "status"],
  ["created_at", "createdAt"],
  ["first_delivered_at", "firstDeliveredAt"],
  ["calls", "calls"],
  ["tokens_input", "tokensInput"],
  ["tokens_output", "tokensOutput"],
  ["tokens_cache_write", "tokensCacheWrite"],
  ["tokens_cache_read", "tokensCacheRead"],
  ["audio_seconds", "audioSeconds"],
  ["renders", "renders"],
  ["usd", "usd"],
  ["first_delivery_usd", "firstDeliveryUsd"],
  ["revision_usd", "revisionUsd"],
] as const satisfies readonly (readonly [string, keyof UsageCsvRow])[];

/** Текстові колонки, значення яких приходить ззовні: у них гаситься формула (CSV injection). */
const TEXT_KEYS: ReadonlySet<keyof UsageCsvRow> = new Set(["ownerEmail", "host", "status"]);
/** Початок клітинки, який Excel / Sheets читають як формулу. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Рядок, що починається з `= + - @ \t \r`, отримує префікс `'` (таблиця покаже його як текст); інше — як є. */
export function csvText(value: string | number | null): string | number | null {
  return typeof value === "string" && FORMULA_START.test(value) ? `'${value}` : value;
}

/** Поле CSV: `null` → порожнє; лапки, якщо є кома, лапки, `\r` або `\n`; лапки подвоюються. */
export function csvField(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * `projects.csv`: BOM, заголовок, рядки в наданому порядку, кожен рядок завершено `\r\n`.
 * У `owner_email`, `host`, `status` формули гасяться (`csvText`); числа не чіпаються.
 */
export function toCsv(rows: UsageCsvRow[]): string {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(",")];
  for (const row of rows)
    lines.push(
      CSV_COLUMNS.map(([, key]) => csvField(TEXT_KEYS.has(key) ? csvText(row[key]) : row[key])).join(","),
    );
  return CSV_BOM + lines.join(CSV_EOL) + CSV_EOL;
}
