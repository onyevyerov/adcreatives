import { SceneId } from "@adc/shared";

/**
 * Розбір відповіді `codegen`/`code-fix` на файли сцен і генерація реєстру `scenes/index.ts`.
 *
 * Формат відповіді (див. prompts/codegen.md):
 *
 *   <file name="s1.tsx">
 *   …код…
 *   </file>
 *
 * Розбір терпимий: допускає `path=`, шлях `scenes/s1.tsx`, одинарні лапки і markdown-огорожу
 * всередині блоку. Як запасний варіант (одна сцена у `code-fix`) — перший ```tsx блок.
 */

export interface ParsedFile {
  /** Ім'я файлу як у відповіді. */
  name: string;
  /** s1, s2, … (з імені файлу); null — ім'я не схоже на файл сцени. */
  sceneId: string | null;
  code: string;
}

/**
 * Вміст блоку не містить початку іншого `<file`: обірваний блок (обрізаний стрім, повтор виклику
 * після обриву) відкидається, а не ковтає наступний повний блок.
 */
const FILE_BLOCK = /<file\s+(?:name|path)\s*=\s*["']([^"']+)["']\s*>((?:(?!<file\s)[\s\S])*?)<\/file>/gi;
const FENCE = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/;
const ANY_FENCE = /```(?:tsx|typescript|ts|jsx)?\s*\n([\s\S]*?)\n```/;

function stripFence(code: string): string {
  const m = FENCE.exec(code);
  return `${(m ? (m[1] ?? "") : code).replace(/^\s*\n/, "").trimEnd()}\n`;
}

export function sceneIdFromFileName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = /^(s\d{1,2})\.tsx$/i.exec(base);
  if (!m) return null;
  const id = (m[1] as string).toLowerCase();
  return SceneId.safeParse(id).success ? id : null;
}

/** Усі `<file>`-блоки відповіді. Повторне ім'я — перемагає останній блок. */
export function parseFileBlocks(text: string): ParsedFile[] {
  const byName = new Map<string, ParsedFile>();
  for (const m of text.matchAll(FILE_BLOCK)) {
    const name = (m[1] ?? "").trim();
    const code = stripFence(m[2] ?? "");
    if (!code.trim()) continue;
    byName.set(name, { name, sceneId: sceneIdFromFileName(name), code });
  }
  return [...byName.values()];
}

/**
 * Код однієї сцени з відповіді `code-fix`: `<file>` для потрібної сцени, будь-який єдиний
 * `<file>`, або перший блок коду в огорожі.
 */
export function parseSingleScene(text: string, sceneId: string): string | null {
  const files = parseFileBlocks(text);
  const exact = files.find((f) => f.sceneId === sceneId);
  if (exact) return exact.code;
  if (files.length === 1) return (files[0] as ParsedFile).code;
  const fence = ANY_FENCE.exec(text);
  if (fence?.[1]?.trim()) return `${fence[1].replace(/\s+$/, "")}\n`;
  return null;
}

/**
 * Реєстр сцен задачі — контракт хоста `apps/remotion` (`@job/scenes`):
 *
 *   import S1 from "./s1.tsx";
 *   export default { s1: S1 };
 */
export function scenesIndexSource(sceneIds: readonly string[]): string {
  const ids = [...new Set(sceneIds)].filter((id) => SceneId.safeParse(id).success);
  const lines = [
    "// Згенеровано @adc/director — не редагувати вручну.",
    ...ids.map((id) => `import ${id.toUpperCase()} from "./${id}.tsx";`),
    "",
    `export default { ${ids.map((id) => `${id}: ${id.toUpperCase()}`).join(", ")} };`,
    "",
  ];
  return lines.join("\n");
}
