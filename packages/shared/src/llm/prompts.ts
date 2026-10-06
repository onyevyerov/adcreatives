import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { findRepoRoot } from "../env.ts";
import { shortHash } from "../storage/hash.ts";

/**
 * Промпти — файли `prompts/<name>.md`:
 *
 * ```md
 * ---
 * model: claude-opus-5-5
 * effort: high
 * max_tokens: 32000
 * cache: true
 * ---
 * Системна частина (стабільна, кешується). Змінні: {{var}}.
 *
 * === user ===
 * Користувацька частина з даними: {{site}}
 * ```
 *
 * Рядок `=== user ===` відділяє system від user. Без нього все тіло — system,
 * а user-текст передається у виклику (`opts.userText`).
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;

export const PromptFrontmatter = z.object({
  model: z.string().min(1),
  effort: Effort,
  max_tokens: z.number().int().positive(),
  cache: z.boolean().default(true),
  description: z.string().optional(),
});
export type PromptFrontmatter = z.infer<typeof PromptFrontmatter>;

export interface LoadedPrompt {
  name: string;
  system: string;
  /** null — у файлі немає секції `=== user ===`. */
  user: string | null;
  model: string;
  effort: Effort;
  maxTokens: number;
  cache: boolean;
  /** Хеш вмісту файлу (до підстановки змінних) — версія промпта. */
  hash: string;
}

export type PromptVars = Record<string, unknown>;

export interface PromptLoader {
  load(name: string, vars?: PromptVars): LoadedPrompt;
}

export class PromptError extends Error {
  override name = "PromptError";
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const USER_SEPARATOR = /^[ \t]*={3,}[ \t]*user[ \t]*={3,}[ \t]*$/im;
const VAR = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

export function parsePromptFile(raw: string, name = "<prompt>"): { meta: PromptFrontmatter; body: string } {
  const m = FRONTMATTER.exec(raw);
  if (!m) throw new PromptError(`${name}: немає frontmatter (--- … ---)`);
  const parsed = PromptFrontmatter.safeParse(parseYaml(m[1] ?? "") ?? {});
  if (!parsed.success) throw new PromptError(`${name}: невірний frontmatter: ${parsed.error.message}`);
  return { meta: parsed.data, body: m[2] ?? "" };
}

function lookup(vars: PromptVars, dotted: string): unknown {
  let cur: unknown = vars;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Підставляє `{{var}}`; рядки як є, решта — JSON. Відсутня змінна — помилка. */
export function renderTemplate(template: string, vars: PromptVars, name = "<prompt>"): string {
  return template.replace(VAR, (_, key: string) => {
    const value = lookup(vars, key);
    if (value === undefined) throw new PromptError(`${name}: не передано змінну {{${key}}}`);
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}

export function buildPrompt(name: string, raw: string, vars: PromptVars = {}): LoadedPrompt {
  const { meta, body } = parsePromptFile(raw, name);
  const sep = USER_SEPARATOR.exec(body);
  const systemTpl = sep ? body.slice(0, sep.index) : body;
  const userTpl = sep ? body.slice(sep.index + sep[0].length) : null;
  return {
    name,
    system: renderTemplate(systemTpl, vars, name).trim(),
    user: userTpl === null ? null : renderTemplate(userTpl, vars, name).trim(),
    model: meta.model,
    effort: meta.effort,
    maxTokens: meta.max_tokens,
    cache: meta.cache,
    hash: shortHash(raw.replaceAll("\r\n", "\n")),
  };
}

export interface PromptLoaderOptions {
  /** Тека з промптами; дефолт — `<repo>/prompts` або env PROMPTS_DIR. */
  dir?: string;
  /** Перечитувати файл на кожен виклик (дефолт: усе, крім NODE_ENV=production). */
  reload?: boolean;
}

export function defaultPromptsDir(): string {
  return process.env.PROMPTS_DIR
    ? path.resolve(process.env.PROMPTS_DIR)
    : path.join(findRepoRoot(), "prompts");
}

export function createPromptLoader(options: PromptLoaderOptions = {}): PromptLoader {
  const dir = options.dir ?? defaultPromptsDir();
  const reload = options.reload ?? process.env.NODE_ENV !== "production";
  const cache = new Map<string, string>();
  const readRaw = (name: string): string => {
    if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(name)) {
      throw new PromptError(`недопустима назва промпта: ${name}`);
    }
    if (!reload && cache.has(name)) return cache.get(name) as string;
    let raw: string;
    try {
      raw = readFileSync(path.join(dir, ...`${name}.md`.split("/")), "utf8");
    } catch (err) {
      throw new PromptError(`не знайдено промпт ${name} у ${dir}: ${(err as Error).message}`);
    }
    cache.set(name, raw);
    return raw;
  };
  return {
    load: (name, vars = {}) => buildPrompt(name, readRaw(name), vars),
  };
}

let defaultLoader: PromptLoader | null = null;

/** Завантажує промпт із дефолтної теки: {system, user, model, effort, maxTokens, hash}. */
export function loadPrompt(name: string, vars: PromptVars = {}): LoadedPrompt {
  defaultLoader ??= createPromptLoader();
  return defaultLoader.load(name, vars);
}
