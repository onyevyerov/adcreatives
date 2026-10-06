import { createHash } from "node:crypto";

/** JSON з відсортованими ключами — однаковий для однакових даних. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => [k, sortDeep(obj[k])]),
    );
  }
  return value;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Короткий хеш (16 hex) — для імен тек і журналів. */
export function shortHash(data: string | Uint8Array): string {
  return sha256(data).slice(0, 16);
}

/**
 * Хеш входів артефакта. Однаковий хеш у попередній ревізії = артефакт можна скопіювати.
 * Порядок ключів не впливає; Buffer/Uint8Array хешуються вмістом.
 */
export function inputsHash(inputs: Record<string, unknown>): string {
  const h = createHash("sha256");
  for (const key of Object.keys(inputs).sort()) {
    const v = inputs[key];
    if (v === undefined) continue;
    h.update(key);
    h.update("\0");
    h.update(v instanceof Uint8Array ? v : stableStringify(v));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}
