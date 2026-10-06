import type { JsonPatchOp } from "@adc/shared";

/**
 * Мінімальний JSON Patch (RFC 6902) для правок бренд-кіта.
 * Значення приходить JSON-рядком (`valueJson`), бо structured output не приймає довільний тип.
 */

export class JsonPatchError extends Error {
  override name = "JsonPatchError";
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Container = Json[] | { [k: string]: Json };

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new JsonPatchError(`шлях має починатися з «/»: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
}

const isContainer = (v: unknown): v is Container => typeof v === "object" && v !== null;

function arrayIndex(arr: Json[], token: string, forInsert: boolean): number {
  if (token === "-" && forInsert) return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new JsonPatchError(`недопустимий індекс масиву: ${token}`);
  const i = Number(token);
  if (i > arr.length || (!forInsert && i === arr.length)) {
    throw new JsonPatchError(`індекс ${i} за межами масиву довжини ${arr.length}`);
  }
  return i;
}

function parentOf(doc: Json, tokens: string[]): { parent: Container; key: string } {
  if (tokens.length === 0) throw new JsonPatchError("операції над коренем документа заборонені");
  let cur: Json = doc;
  for (const t of tokens.slice(0, -1)) {
    if (!isContainer(cur)) throw new JsonPatchError(`шлях не існує: /${tokens.join("/")}`);
    const next: Json | undefined = Array.isArray(cur) ? cur[arrayIndex(cur, t, false)] : cur[t];
    if (next === undefined) throw new JsonPatchError(`шлях не існує: /${tokens.join("/")}`);
    cur = next;
  }
  if (!isContainer(cur)) throw new JsonPatchError(`шлях не існує: /${tokens.join("/")}`);
  return { parent: cur, key: tokens[tokens.length - 1] as string };
}

function getAt(doc: Json, pointer: string): Json {
  const { parent, key } = parentOf(doc, parsePointer(pointer));
  const v = Array.isArray(parent) ? parent[arrayIndex(parent, key, false)] : parent[key];
  if (v === undefined) throw new JsonPatchError(`шлях не існує: ${pointer}`);
  return v;
}

function addAt(doc: Json, pointer: string, value: Json): void {
  const { parent, key } = parentOf(doc, parsePointer(pointer));
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, true), 0, value);
  else parent[key] = value;
}

function removeAt(doc: Json, pointer: string): Json {
  const { parent, key } = parentOf(doc, parsePointer(pointer));
  if (Array.isArray(parent)) return parent.splice(arrayIndex(parent, key, false), 1)[0] as Json;
  if (!(key in parent)) throw new JsonPatchError(`шлях не існує: ${pointer}`);
  const v = parent[key] as Json;
  delete parent[key];
  return v;
}

function replaceAt(doc: Json, pointer: string, value: Json): void {
  const { parent, key } = parentOf(doc, parsePointer(pointer));
  if (Array.isArray(parent)) parent[arrayIndex(parent, key, false)] = value;
  else {
    if (!(key in parent)) throw new JsonPatchError(`шлях не існує: ${pointer}`);
    parent[key] = value;
  }
}

const clone = <T>(v: T): T => structuredClone(v);

/** Значення операції: JSON із `valueJson`; невалідний JSON трактується як рядок («#FF0000» без лапок). */
export function opValue(op: JsonPatchOp): Json {
  if (op.valueJson === null) throw new JsonPatchError(`${op.op} ${op.path}: немає valueJson`);
  try {
    return JSON.parse(op.valueJson) as Json;
  } catch {
    return op.valueJson;
  }
}

/** Застосовує одну операцію до документа на місці. */
export function applyOp(doc: Json, op: JsonPatchOp): void {
  switch (op.op) {
    case "add":
      addAt(doc, op.path, opValue(op));
      return;
    case "remove":
      removeAt(doc, op.path);
      return;
    case "replace":
      replaceAt(doc, op.path, opValue(op));
      return;
    case "move": {
      if (op.from === null) throw new JsonPatchError(`move ${op.path}: немає from`);
      if (op.path.startsWith(`${op.from}/`)) throw new JsonPatchError("move у власного нащадка");
      addAt(doc, op.path, removeAt(doc, op.from));
      return;
    }
    case "copy": {
      if (op.from === null) throw new JsonPatchError(`copy ${op.path}: немає from`);
      addAt(doc, op.path, clone(getAt(doc, op.from)));
      return;
    }
    case "test": {
      const actual = getAt(doc, op.path);
      if (JSON.stringify(actual) !== JSON.stringify(opValue(op))) {
        throw new JsonPatchError(`test ${op.path}: значення не збігається`);
      }
      return;
    }
  }
}

export interface PatchOutcome<T> {
  doc: T;
  applied: JsonPatchOp[];
  skipped: Array<{ op: JsonPatchOp; reason: string }>;
}

/**
 * Застосовує операції по одній до копії документа. Операція, що падає або (якщо задано `accept`)
 * робить документ невалідним, пропускається — решта правок усе одно застосовується.
 */
export function applyPatch<T>(
  input: T,
  ops: readonly JsonPatchOp[],
  accept?: (doc: unknown) => string | null,
): PatchOutcome<T> {
  let doc = clone(input) as unknown as Json;
  const applied: JsonPatchOp[] = [];
  const skipped: PatchOutcome<T>["skipped"] = [];
  for (const op of ops) {
    const next = clone(doc);
    try {
      applyOp(next, op);
    } catch (err) {
      skipped.push({ op, reason: (err as Error).message });
      continue;
    }
    const problem = accept?.(next) ?? null;
    if (problem) {
      skipped.push({ op, reason: problem });
      continue;
    }
    doc = next;
    applied.push(op);
  }
  return { doc: doc as unknown as T, applied, skipped };
}
