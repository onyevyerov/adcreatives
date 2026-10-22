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

/** Поле CSV: `null` → порожнє; лапки, якщо є кома, лапки, `\r` або `\n`; лапки подвоюються. */
export function csvField(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** `projects.csv`: BOM, заголовок, рядки в наданому порядку, кожен рядок завершено `\r\n`. */
export function toCsv(rows: UsageCsvRow[]): string {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map(([, key]) => csvField(row[key])).join(","));
  return CSV_BOM + lines.join(CSV_EOL) + CSV_EOL;
}
