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
 *
 * Необов'язковий рядок `=== cache ===` усередині user-частини: текст до нього — окремий user-блок
 * з `cache_control` (5 хв), після — хвіст без кешу.
 *
 * Frontmatter, крім `model` / `effort` / `max_tokens`:
 * - `kind: prefix` — лише системна довідка для інших промптів (без user-частини, `model` / `effort` /
 *   `max_tokens` не потрібні); завантажити його як звичайний промпт — `PromptError`;
 * - `prefix: <ім'я>` — system промпта `kind: prefix`, відрендерений з тими самими змінними, іде першим
 *   системним блоком зі своїм breakpoint і своїм `cache_ttl`;
 * - `cache_ttl: 5m | 1h` — TTL breakpoint-а системного блоку; TTL не зростають за порядком блоків
 *   (prefix ≥ stage ≥ user-cache), бо API вимагає довші TTL перед коротшими;
 * - `schema_mode: prompt` — JSON Schema одразу в промпті, без спроби граматики API.
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;

export const PromptKind = z.enum(["call", "prefix"]);
export type PromptKind = z.infer<typeof PromptKind>;

export const CacheTtl = z.enum(["5m", "1h"]);
export type CacheTtl = z.infer<typeof CacheTtl>;

export const SchemaMode = z.enum(["grammar", "prompt"]);
export type SchemaMode = z.infer<typeof SchemaMode>;

export const PromptFrontmatter = z
  .object({
    kind: PromptKind.default("call"),
    model: z.string().min(1).optional(),
    effort: Effort.optional(),
    max_tokens: z.number().int().positive().optional(),
    cache: z.boolean().default(true),
    cache_ttl: CacheTtl.default("5m"),
    prefix: z.string().min(1).optional(),
    schema_mode: SchemaMode.default("grammar"),
    description: z.string().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.kind === "call") {
      for (const key of ["model", "effort", "max_tokens"] as const) {
        if (m[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: "обов'язкове поле" });
      }
      return;
    }
    if (m.prefix !== undefined) {
      ctx.addIssue({ code: "custom", path: ["prefix"], message: "prefix не може мати власний prefix" });
    }
    if (!m.cache) {
      ctx.addIssue({ code: "custom", path: ["cache"], message: "prefix існує лише для кешу" });
    }
  });
export type PromptFrontmatter = z.infer<typeof PromptFrontmatter>;

/** Відрендерена довідка `kind: prefix` — перший системний блок промпта. */
export interface LoadedPromptPrefix {
  name: string;
  system: string;
  cacheTtl: CacheTtl;
  /** Хеш файлу prefix. */
  hash: string;
}

export interface LoadedPrompt {
  name: string;
  system: string;
  /**
   * Хвіст user-частини (після `=== cache ===`, або вся user-частина без цього рядка);
   * null — у файлі немає секції `=== user ===`.
   */
  user: string | null;
  /** User-текст до `=== cache ===` — окремий user-блок з `cache_control` (5 хв); null — рядка немає. */
  userCached: string | null;
  model: string;
  effort: Effort;
  maxTokens: number;
  /** false — жодних breakpoint-ів цього промпта (ні system, ні userCached); prefix кешується завжди. */
  cache: boolean;
  /** TTL breakpoint-а власного системного блоку. */
  cacheTtl: CacheTtl;
  schemaMode: SchemaMode;
  prefix: LoadedPromptPrefix | null;
  /** Хеш вмісту файлу (до підстановки змінних) + файлу prefix — версія промпта. */
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
const CACHE_SEPARATOR = /^[ \t]*={3,}[ \t]*cache[ \t]*={3,}[ \t]*$/gim;
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

const TTL_RANK: Record<CacheTtl, number> = { "5m": 0, "1h": 1 };

const normalize = (raw: string) => raw.replaceAll("\r\n", "\n");

function splitBody(body: string, name: string) {
  const sep = USER_SEPARATOR.exec(body);
  const systemTpl = sep ? body.slice(0, sep.index) : body;
  const userTpl = sep ? body.slice(sep.index + sep[0].length) : null;
  if (systemTpl.match(CACHE_SEPARATOR)) {
    throw new PromptError(`${name}: рядок === cache === дозволений лише в user-частині`);
  }
  const marks = userTpl?.match(CACHE_SEPARATOR)?.length ?? 0;
  if (marks > 1) throw new PromptError(`${name}: більше одного рядка === cache ===`);
  if (userTpl === null || marks === 0) return { systemTpl, userCachedTpl: null, userTpl };
  const [cached = "", tail = ""] = userTpl.split(CACHE_SEPARATOR);
  return { systemTpl, userCachedTpl: cached, userTpl: tail };
}

/** Читає сирий файл іншого промпта (для `prefix`). */
export type ReadPromptRaw = (name: string) => string;

function buildPrefix(name: string, raw: string, vars: PromptVars): LoadedPromptPrefix {
  const { meta, body } = parsePromptFile(raw, name);
  if (meta.kind !== "prefix") throw new PromptError(`${name}: це не промпт kind: prefix`);
  if (USER_SEPARATOR.test(body)) throw new PromptError(`${name}: у prefix не може бути user-частини`);
  return {
    name,
    system: renderTemplate(body, vars, name).trim(),
    cacheTtl: meta.cache_ttl,
    hash: shortHash(normalize(raw)),
  };
}

export function buildPrompt(
  name: string,
  raw: string,
  vars: PromptVars = {},
  readRaw?: ReadPromptRaw,
): LoadedPrompt {
  const { meta, body } = parsePromptFile(raw, name);
  if (meta.kind === "prefix") {
    throw new PromptError(
      `${name}: kind: prefix — лише довідка для інших промптів, прямий виклик заборонено`,
    );
  }
  const { systemTpl, userCachedTpl, userTpl } = splitBody(body, name);

  let prefix: LoadedPromptPrefix | null = null;
  let prefixRaw = "";
  if (meta.prefix !== undefined) {
    if (!readRaw) throw new PromptError(`${name}: prefix ${meta.prefix} — немає звідки його прочитати`);
    prefixRaw = readRaw(meta.prefix);
    prefix = buildPrefix(meta.prefix, prefixRaw, vars);
    if (meta.cache && TTL_RANK[prefix.cacheTtl] < TTL_RANK[meta.cache_ttl]) {
      throw new PromptError(
        `${name}: cache_ttl ${meta.cache_ttl} довший за cache_ttl ${prefix.cacheTtl} prefix ${meta.prefix} ` +
          "(API вимагає довші TTL перед коротшими)",
      );
    }
  }

  const userCached = userCachedTpl === null ? null : renderTemplate(userCachedTpl, vars, name).trim();
  const own = normalize(raw);
  return {
    name,
    system: renderTemplate(systemTpl, vars, name).trim(),
    user: userTpl === null ? null : renderTemplate(userTpl, vars, name).trim(),
    userCached: userCached || null,
    // kind: call гарантує ці поля (PromptFrontmatter.superRefine).
    model: meta.model as string,
    effort: meta.effort as Effort,
    maxTokens: meta.max_tokens as number,
    cache: meta.cache,
    cacheTtl: meta.cache_ttl,
    schemaMode: meta.schema_mode,
    prefix,
    hash: prefix ? shortHash(`${own}\0${meta.prefix}\0${normalize(prefixRaw)}`) : shortHash(own),
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
    load: (name, vars = {}) => buildPrompt(name, readRaw(name), vars, readRaw),
  };
}

let defaultLoader: PromptLoader | null = null;

/** Завантажує промпт із дефолтної теки: {system, user, model, effort, maxTokens, hash}. */
export function loadPrompt(name: string, vars: PromptVars = {}): LoadedPrompt {
  defaultLoader ??= createPromptLoader();
  return defaultLoader.load(name, vars);
}
