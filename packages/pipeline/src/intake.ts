import {
  type ChatIntent,
  type Format,
  IntakeFile,
  type Language,
  normalizeFormats,
  projectPaths,
  type Storage,
} from "@adc/shared";

export { IntakeFile } from "@adc/shared";

export const intakeKey = (projectId: string) => projectPaths(projectId).intake;

export async function readIntake(storage: Storage, projectId: string): Promise<IntakeFile | null> {
  const key = intakeKey(projectId);
  if (!(await storage.exists(key))) return null;
  return storage.readJson(key, (v) => IntakeFile.parse(v));
}

// ───────────── дешевий детермінований розбір службових реплік ─────────────

const FORMAT_TOKENS: Array<[RegExp, Format]> = [
  [/9\s*[:x×/]\s*16|вертик|vertical|stor(y|ies)|сторіс|reels/i, "vertical"],
  [/1\s*[:x×/]\s*1|квадрат|square/i, "square"],
  [/16\s*[:x×/]\s*9|горизонт|landscape|horizontal/i, "landscape"],
];

const LANGUAGE_TOKENS: Array<[RegExp, Language]> = [
  [/^(uk|ua|укр|українськ|ukrainian)/i, "uk"],
  [/^(en|eng|англ|english)/i, "en"],
];

/**
 * Репліки на кшталт «Формати: 9:16, 1:1» і «Мова відео: en» (їх надсилає сторінка чату)
 * розбираються без LLM. Повертає null, якщо в тексті є щось інше — тоді працює chat-intent.
 */
export function preparseIntent(text: string): ChatIntent | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  let formats: Format[] | null = null;
  let language: Language | null = null;
  for (const line of lines) {
    const m = /^(формат(?:и)?(?:\s+відео)?|formats?|мова(?:\s+відео)?|language)\s*[:—-]\s*(.+)$/i.exec(line);
    if (!m) return null;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key.startsWith("мова") || key.startsWith("language")) {
      const found = LANGUAGE_TOKENS.find(([re]) => re.test(value));
      if (!found) return null;
      language = found[1];
    } else {
      const parts = value.split(/[,;]|\s+і\s+|\s+та\s+|\s+and\s+/i).map((p) => p.trim());
      const picked: Format[] = [];
      for (const part of parts.filter(Boolean)) {
        const found = FORMAT_TOKENS.find(([re]) => re.test(part));
        if (!found) return null;
        picked.push(found[1]);
      }
      if (picked.length === 0) return null;
      formats = normalizeFormats(picked);
    }
  }
  return {
    kind: "answer",
    answers: [],
    formats,
    language,
    brandEdits: null,
    edits: null,
    facts: [],
    durationSeconds: null,
    question: null,
  };
}
