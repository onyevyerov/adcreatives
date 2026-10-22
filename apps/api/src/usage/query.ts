import { z } from "zod";
import type { CsvQuery, ProjectsQuery, UsageWindow, UsersQuery } from "./types.ts";

/**
 * Розбір query-параметрів `GET /api/admin/usage/*` (`docs/usage-api.md`). Двигун отримує лише валідні
 * запити з підставленими дефолтами. Невідомі параметри ігноруються; порожнє значення = параметр відсутній.
 */

export const USAGE_DEFAULT_PAGE = 1;
export const USAGE_DEFAULT_PAGE_SIZE = 25;
export const USAGE_MAX_PAGE_SIZE = 200;

export const RANGE_MESSAGE = "Дата «До» раніша за «Від».";

/** Сирі параметри запиту (`c.req.query()`). */
export type RawQuery = Record<string, string | undefined>;

export type QueryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "invalid_query" | "invalid_range"; message: string };

const ok = <T>(value: T): QueryResult<T> => ({ ok: true, value });
const fail = (error: "invalid_query" | "invalid_range", message: string): QueryResult<never> => ({
  ok: false,
  error,
  message,
});

/**
 * Справжня календарна дата `YYYY-MM-DD` (2026-02-30 — ні). Рік ставиться `setUTCFullYear`, бо
 * `Date.UTC` переносить роки 0–99 у 1900–1999 (і `0099-01-01` відкидався б).
 */
function isRealDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y ?? 0, (m ?? 0) - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === (m ?? 0) - 1 && date.getUTCDate() === d;
}

const DateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealDate);
const SourceParam = z.enum(["chat", "eval", "test", "all"]);
const OrderParam = z.enum(["asc", "desc"]);
const UsersSortParam = z.enum(["usd", "email", "projects", "createdAt", "marginUsd"]);
const ProjectsSortParam = z.enum(["usd", "createdAt", "tokens", "calls", "host", "status", "ownerEmail"]);
const PositiveInt = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1));
const PageSizeParam = PositiveInt.pipe(z.number().max(USAGE_MAX_PAGE_SIZE));

/** Один параметр: відсутній або порожній → `def`; невалідний → 400 `invalid_query` з `message`. */
function param<T>(
  raw: RawQuery,
  name: string,
  schema: z.ZodType<T>,
  def: T,
  message: string,
): QueryResult<T> {
  const v = raw[name];
  if (v === undefined || v === "") return ok(def);
  const parsed = schema.safeParse(v);
  return parsed.success ? ok(parsed.data) : fail("invalid_query", message);
}

const DATE_MESSAGE = (name: string) => `${name} — дата у форматі РРРР-ММ-ДД, наприклад 2026-10-01.`;
const ORDER_MESSAGE = "order — asc або desc.";
const SOURCE_MESSAGE = "source — chat, eval, test або all.";

/** Виконує розбори по черзі; перша помилка виграє. */
function collect<T extends Record<string, unknown>>(
  parts: {
    [K in keyof T]: QueryResult<T[K]>;
  },
): QueryResult<T> {
  const out: Record<string, unknown> = {};
  for (const [key, r] of Object.entries(parts) as [string, QueryResult<unknown>][]) {
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return ok(out as T);
}

/** `from`, `to`, `source` → `UsageWindow`; `to < from` → 400 `invalid_range`. */
export function parseWindow(raw: RawQuery): QueryResult<UsageWindow> {
  const parts = collect({
    from: param<string | null>(raw, "from", DateParam, null, DATE_MESSAGE("from")),
    to: param<string | null>(raw, "to", DateParam, null, DATE_MESSAGE("to")),
    source: param<UsageWindow["source"]>(raw, "source", SourceParam, "chat", SOURCE_MESSAGE),
  });
  if (!parts.ok) return parts;
  const { from, to } = parts.value;
  if (from !== null && to !== null && to < from) return fail("invalid_range", RANGE_MESSAGE);
  return parts;
}

export function parseUsersQuery(raw: RawQuery): QueryResult<UsersQuery> {
  const window = parseWindow(raw);
  if (!window.ok) return window;
  const rest = collect({
    sort: param<UsersQuery["sort"]>(
      raw,
      "sort",
      UsersSortParam,
      "usd",
      "sort — usd, email, projects, createdAt або marginUsd.",
    ),
    order: param<UsersQuery["order"]>(raw, "order", OrderParam, "desc", ORDER_MESSAGE),
  });
  return rest.ok ? ok({ ...window.value, ...rest.value }) : rest;
}

/** `owner` (відсутній/порожній → null; решта як є) і `search` (обрізаний; порожній → null). */
function ownerAndSearch(raw: RawQuery): { owner: string | null; search: string | null } {
  const owner = raw.owner === undefined || raw.owner === "" ? null : raw.owner;
  const search = raw.search?.trim() || null;
  return { owner, search };
}

export function parseProjectsQuery(raw: RawQuery): QueryResult<ProjectsQuery> {
  const window = parseWindow(raw);
  if (!window.ok) return window;
  const rest = collect({
    sort: param<ProjectsQuery["sort"]>(
      raw,
      "sort",
      ProjectsSortParam,
      "usd",
      "sort — usd, createdAt, tokens, calls, host, status або ownerEmail.",
    ),
    order: param<ProjectsQuery["order"]>(raw, "order", OrderParam, "desc", ORDER_MESSAGE),
    page: param(raw, "page", PositiveInt, USAGE_DEFAULT_PAGE, "page — ціле число від 1."),
    pageSize: param(
      raw,
      "pageSize",
      PageSizeParam,
      USAGE_DEFAULT_PAGE_SIZE,
      `pageSize — ціле число від 1 до ${USAGE_MAX_PAGE_SIZE}.`,
    ),
  });
  return rest.ok ? ok({ ...window.value, ...ownerAndSearch(raw), ...rest.value }) : rest;
}

/** CSV: лише `owner`, вікно й `search` (сортування `usd ↓` — справа двигуна, без пагінації). */
export function parseCsvQuery(raw: RawQuery): QueryResult<CsvQuery> {
  const window = parseWindow(raw);
  return window.ok ? ok({ ...window.value, ...ownerAndSearch(raw) }) : window;
}
