import type { EpidemicErrorKind } from "../provider.ts";

/** Класифікація помилки виклику Epidemic. Заглушка Кроку 0: завжди `other`; наповнює B1. */
export function classifyEpidemicError(err: unknown): { kind: EpidemicErrorKind; status: number | null } {
  void err;
  return { kind: "other", status: null };
}
