import { EpidemicError, type EpidemicErrorKind } from "../provider.ts";

/**
 * Класифікація помилки виклику Epidemic (для черги й зрозумілих `StageError`):
 * - `EpidemicError` (клієнт, квота) — його kind/status, шукаємо й у ланцюжку `cause`;
 * - `AbortError` — скасування викликачем (`aborted`), `TimeoutError` і `TypeError` fetch — `network`;
 * - помилка з числовим `status`/`statusCode` — за HTTP-статусом;
 * - решта — `other`.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

/** Вид за HTTP-статусом (спільний для клієнта і класифікатора). */
export function epidemicKindForStatus(status: number): EpidemicErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "other";
}

function errorChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    out.push(cur);
    cur = isObj(cur) ? cur.cause : undefined;
  }
  return out;
}

export function classifyEpidemicError(err: unknown): { kind: EpidemicErrorKind; status: number | null } {
  const chain = errorChain(err);
  const known = chain.find((e): e is EpidemicError => e instanceof EpidemicError);
  if (known) return { kind: known.kind, status: known.status };

  for (const e of chain) {
    if (!isObj(e)) continue;
    const name = typeof e.name === "string" ? e.name : "";
    if (name === "AbortError") return { kind: "aborted", status: null };
    if (name === "TimeoutError") return { kind: "network", status: null };
    const s = e.status ?? e.statusCode;
    if (typeof s === "number" && s >= 400) return { kind: epidemicKindForStatus(s), status: s };
    if (e instanceof TypeError) return { kind: "network", status: null };
  }
  return { kind: "other", status: null };
}
