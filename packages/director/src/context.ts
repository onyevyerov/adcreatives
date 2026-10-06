import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shortHash } from "@adc/shared";

/**
 * Довідковий контекст для промптів `codegen` і `code-fix` (system-частина, кешується):
 * - вендорна копія https://www.remotion.dev/system-prompt.txt (`vendor/remotion-system-prompt.txt`,
 *   завантажено 2026-10-06; оновлювати вручну);
 * - `packages/motion-kit/API.md` (контракт і правила) + `API.generated.md` (декларації з .d.ts);
 * - еталонні сцени `packages/motion-kit/examples/*.tsx`.
 */

const require = createRequire(import.meta.url);
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function motionKitDir(): string {
  return path.dirname(require.resolve("@adc/motion-kit/package.json"));
}

export interface CodegenContext {
  remotionSystemPrompt: string;
  motionKitApi: string;
  motionKitDeclarations: string;
  /** Еталонні сцени: файл → код. */
  examples: Record<string, string>;
  /** Еталони одним текстом у форматі `<file>`. */
  examplesText: string;
  /** Хеш усього контексту — входить у хеш входів codegen/fix. */
  hash: string;
}

let cached: CodegenContext | null = null;

/** Еталонні сцени motion-kit: ім'я файлу без розширення → код. */
export function readExampleScenes(): Record<string, string> {
  const dir = path.join(motionKitDir(), "examples");
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith(".tsx"))
      out[f.slice(0, -4)] = readFileSync(path.join(dir, f), "utf8").replaceAll("\r\n", "\n");
  }
  return out;
}

/** Завантажує контекст (раз на процес; у dev — щоразу, як і промпти). */
export function loadCodegenContext(opts: { reload?: boolean } = {}): CodegenContext {
  const reload = opts.reload ?? process.env.NODE_ENV !== "production";
  if (cached && !reload) return cached;
  const mk = motionKitDir();
  const read = (p: string) => readFileSync(p, "utf8").replaceAll("\r\n", "\n").trim();
  const remotionSystemPrompt = read(path.join(PACKAGE_DIR, "vendor", "remotion-system-prompt.txt"));
  const motionKitApi = read(path.join(mk, "API.md"));
  const motionKitDeclarations = read(path.join(mk, "API.generated.md"));
  const examples = readExampleScenes();
  const examplesText = Object.entries(examples)
    .map(([name, code]) => `<file name="examples/${name}.tsx">\n${code.trim()}\n</file>`)
    .join("\n\n");
  const hash = shortHash(
    [remotionSystemPrompt, motionKitApi, motionKitDeclarations, examplesText].join("\0"),
  );
  cached = { remotionSystemPrompt, motionKitApi, motionKitDeclarations, examples, examplesText, hash };
  return cached;
}

/** Змінні system-частини промптів codegen / code-fix. */
export function contextVars(ctx: CodegenContext): Record<string, string> {
  return {
    remotionSystemPrompt: ctx.remotionSystemPrompt,
    motionKitApi: ctx.motionKitApi,
    motionKitDeclarations: ctx.motionKitDeclarations,
    examples: ctx.examplesText,
  };
}
