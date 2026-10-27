import { parseFileBlocks } from "./files.ts";

/**
 * Модуль патчів стадії `fix` (режим `ADC_FIX_OUTPUT=patch`): замість повного файлу сцени модель
 * повертає список точкових замін.
 *
 *   <edits file="s1.tsx">
 *   <edit>
 *   <old>
 *   …рядки поточного коду дослівно…
 *   </old>
 *   <new>
 *   …заміна (може бути порожньою)…
 *   </new>
 *   </edit>
 *   </edits>
 *
 * Замість `<edits>` модель може повернути повний `<file name="s1.tsx">` — це розпізнається як
 * `kind: "file"`. Модуль нікуди не підключений: його споживає fix (Блок 5).
 */

export interface SceneEdit {
  old: string;
  new: string;
}

export type ParsedFixOutput =
  | { kind: "edits"; edits: SceneEdit[] }
  | { kind: "file"; code: string }
  | { kind: "none" };

const EDITS_BLOCK = /<edits(\s[^>]*)?>([\s\S]*?)<\/edits>/gi;
const EDIT_BLOCK = /<edit>([\s\S]*?)<\/edit>/gi;
const OLD_BLOCK = /<old>([\s\S]*?)<\/old>/i;
const NEW_BLOCK = /<new>([\s\S]*?)<\/new>/i;
const FILE_ATTR = /\b(?:file|name|path)\s*=\s*["']([^"']+)["']/i;

function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** Знімає рівно один перший і один останній перенос рядка. */
function trimOneNewline(s: string): string {
  let out = s;
  if (out.startsWith("\n")) out = out.slice(1);
  if (out.endsWith("\n")) out = out.slice(0, -1);
  return out;
}

function baseName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).trim().toLowerCase();
}

function parseEdits(text: string, sceneId: string): SceneEdit[] | null {
  for (const block of text.matchAll(EDITS_BLOCK)) {
    const file = FILE_ATTR.exec(block[1] ?? "")?.[1];
    if (file !== undefined && baseName(file) !== `${sceneId.toLowerCase()}.tsx`) continue;
    const edits: SceneEdit[] = [];
    let malformed = false;
    for (const e of (block[2] ?? "").matchAll(EDIT_BLOCK)) {
      const o = OLD_BLOCK.exec(e[1] ?? "");
      const n = NEW_BLOCK.exec(e[1] ?? "");
      if (!o || !n) {
        malformed = true;
        break;
      }
      edits.push({ old: trimOneNewline(o[1] ?? ""), new: trimOneNewline(n[1] ?? "") });
    }
    if (!malformed && edits.length > 0) return edits;
  }
  return null;
}

/**
 * Розбір відповіді fix: `<edits>` для потрібної сцени → `edits`; повний `<file>` саме цієї сцени →
 * `file`; інакше (сміття, чужа сцена, зіпсований `<edit>`) → `none`. Якщо є і те, і те — перемагають
 * `<edits>`.
 */
export function parseFixOutput(text: string, sceneId: string): ParsedFixOutput {
  const normalized = normalizeEol(text);
  const edits = parseEdits(normalized, sceneId);
  if (edits) return { kind: "edits", edits };
  const file = parseFileBlocks(normalized).find((f) => f.sceneId === sceneId);
  if (file) return { kind: "file", code: file.code };
  return { kind: "none" };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
}

/**
 * Застосовує правки по черзі до поточного (уже частково зміненого) коду. Кожен `old` — непорожній і
 * рівно один раз; інакше `ok: false` з індексом правки. CRLF нормалізується до LF.
 */
export function applyEdits(
  code: string,
  edits: readonly SceneEdit[],
): { ok: true; code: string } | { ok: false; reason: string; editIndex: number } {
  let current = normalizeEol(code);
  for (const [editIndex, edit] of edits.entries()) {
    const old = normalizeEol(edit.old);
    if (old === "") return { ok: false, reason: "порожній old", editIndex };
    const count = countOccurrences(current, old);
    if (count === 0) return { ok: false, reason: "old не знайдено в коді", editIndex };
    if (count > 1)
      return { ok: false, reason: `old трапляється ${count} разів, потрібен рівно один`, editIndex };
    const at = current.indexOf(old);
    current = current.slice(0, at) + normalizeEol(edit.new) + current.slice(at + old.length);
  }
  return { ok: true, code: current };
}

/** `<output_format>` для режиму file: дослівно «# Output format» з `code-fix.md` + вимога повного коду. */
export function fileOutputFormat(sceneId: string): string {
  return [
    'Only one block `<file name="sN.tsx">…the full repaired code…</file>` (sN is the scene id from the message), with no markdown fences and no explanations.',
    "",
    `Repair scene ${sceneId} and return its full code in \`<file name="${sceneId}.tsx">\`.`,
  ].join("\n");
}

/** `<output_format>` для режиму patch: блоки `<edits>`, правила `old`, коли повертати повний файл. */
export function patchOutputFormat(sceneId: string): string {
  const file = `${sceneId}.tsx`;
  return [
    `Repair scene ${sceneId}. Return only the changes, as one block \`<edits file="${file}">\` with one \`<edit>\` per change, with no markdown fences and no explanations:`,
    "",
    `<edits file="${file}">`,
    "<edit>",
    "<old>",
    "…lines of the current code, copied verbatim…",
    "</old>",
    "<new>",
    "…the replacement (may be empty to delete the lines)…",
    "</new>",
    "</edit>",
    "</edits>",
    "",
    "Rules for `<old>`:",
    "- Copy it verbatim from the current code of the scene: same characters, indentation and line breaks. The first and the last line break inside `<old>` and `<new>` are not part of the text.",
    "- It is never empty.",
    "- It occurs in the code exactly once. If the lines you want to change repeat, include enough neighbouring lines to make `<old>` unique.",
    "- The edits are applied one after another, each to the code the previous edit left. Later `<old>` must match the code as already changed, and edits must not overlap.",
    "",
    `If you change more than half of the file, do not use \`<edits>\`: return the full repaired code in one block \`<file name="${file}">…the full repaired code…</file>\` instead.`,
  ].join("\n");
}
