/**
 * Розбір помилок ElevenLabs. Свідомо толерантний до форми:
 * - `ElevenLabsError` має `statusCode` і `body`;
 * - обгортка SDK для `composeDetailed` перекидає `new Error("Failed to parse …: <message>")`,
 *   втрачаючи тип — тоді статус і тіло дістаємо з тексту повідомлення («Status code: 429», «Body: {…}»);
 * - код помилки шукаємо будь-де в тілі (`detail.status`, `detail.code`, `error.type`…).
 */

export type ElevenLabsErrorKind =
  /** 429 too_many_concurrent_requests — забагато паралельних запитів на акаунт. */
  | "concurrency"
  /** 429 system_busy, інші 429 без коду квоти, 5xx — тимчасово, повтор із паузою. */
  | "busy"
  /** API відхилив промпт/план (назви артистів, бренди, авторські тексти). */
  | "bad_prompt"
  /** Формат відповіді недоступний на тарифі (mp3 192 — від Creator, PCM 44.1 — від Pro). */
  | "format_not_allowed"
  | "aborted"
  | "timeout"
  | "other";

export interface ElevenLabsErrorInfo {
  kind: ElevenLabsErrorKind;
  status: number | null;
  /** Код з тіла (too_many_concurrent_requests, system_busy, bad_prompt, …), якщо знайшовся. */
  code: string | null;
  /** Запропонований API промпт-заміна. */
  promptSuggestion: string | null;
  /** Запропонований API план-заміна (вже з camelCase-ключами). */
  planSuggestion: Record<string, unknown> | null;
  message: string;
}

const KNOWN_CODES = [
  "too_many_concurrent_requests",
  "system_busy",
  "bad_prompt",
  "bad_composition_plan",
  "quota_exceeded",
  "output_format_not_allowed",
  "format_not_allowed",
] as const;

/**
 * Відмова через формат без коду в тілі: текст API згадує формат виводу разом із тарифом
 * («… output format pcm_44100 … requires Pro tier or above»).
 */
const FORMAT_TEXT = /output[_ ]?format|(?:mp3|pcm)_\d{4,5}/i;
const TIER_TEXT = /not (?:allowed|available)|subscri|tier|upgrade|plan does not/i;

const PROMPT_SUGGESTION_KEYS = [
  "prompt_suggestion",
  "promptSuggestion",
  "suggested_prompt",
  "suggestedPrompt",
];
const PLAN_SUGGESTION_KEYS = [
  "composition_plan_suggestion",
  "compositionPlanSuggestion",
  "suggested_composition_plan",
  "suggestedCompositionPlan",
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function errorChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    out.push(cur);
    cur = isObj(cur) || cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return out;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

/** Пошук значення за ключем у глибину (тіло може бути загорнуте в detail/data/error). */
function deepFind(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 6) return undefined;
  const v = parseMaybeJson(value);
  if (Array.isArray(v)) {
    for (const item of v) {
      const found = deepFind(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isObj(v)) return undefined;
  for (const k of keys) if (v[k] !== undefined && v[k] !== null) return parseMaybeJson(v[k]);
  for (const child of Object.values(v)) {
    const found = deepFind(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** snake_case → camelCase рекурсивно (SDK серіалізує запит із camelCase). */
export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (!isObj(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
      camelizeKeys(v),
    ]),
  );
}

function bodyFromMessage(message: string): unknown {
  const idx = message.indexOf("Body:");
  if (idx === -1) return undefined;
  const raw = message.slice(idx + 5).trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Тіло могло бути не JSON (або обрізане) — далі шукаємо коди просто в тексті.
    return raw;
  }
}

export function classifyElevenLabsError(err: unknown): ElevenLabsErrorInfo {
  const chain = errorChain(err);
  const message = chain
    .map((e) => (e instanceof Error ? e.message : typeof e === "string" ? e : ""))
    .filter(Boolean)
    .join(" | ");
  const names = chain.map((e) => (e instanceof Error ? e.name : ""));

  let status: number | null = null;
  let body: unknown;
  for (const e of chain) {
    if (!isObj(e) && !(e instanceof Error)) continue;
    const o = e as Obj;
    const s = o.statusCode ?? o.status;
    if (status === null && typeof s === "number") status = s;
    if (body === undefined && o.body !== undefined) body = o.body;
  }
  if (status === null) {
    const m = /Status code:\s*(\d{3})/i.exec(message);
    if (m) status = Number(m[1]);
  }
  if (body === undefined) body = bodyFromMessage(message);

  const haystack = `${typeof body === "string" ? body : JSON.stringify(body ?? null)} ${message}`;
  const code = KNOWN_CODES.find((c) => haystack.includes(c)) ?? null;

  const promptRaw = deepFind(body, PROMPT_SUGGESTION_KEYS);
  const planRaw = deepFind(body, PLAN_SUGGESTION_KEYS);
  const promptSuggestion = typeof promptRaw === "string" && promptRaw.trim() ? promptRaw.trim() : null;
  const planSuggestion = isObj(planRaw) ? (camelizeKeys(planRaw) as Obj) : null;

  let kind: ElevenLabsErrorKind;
  if (names.includes("AbortError") || (/aborted/i.test(message) && !status)) kind = "aborted";
  else if (names.includes("ElevenLabsTimeoutError") || (/timed? ?out/i.test(message) && !status))
    kind = "timeout";
  else if (
    code === "output_format_not_allowed" ||
    code === "format_not_allowed" ||
    (status !== null &&
      status >= 400 &&
      status < 500 &&
      status !== 429 &&
      FORMAT_TEXT.test(haystack) &&
      TIER_TEXT.test(haystack))
  )
    kind = "format_not_allowed";
  else if (code === "too_many_concurrent_requests") kind = "concurrency";
  else if (code === "system_busy") kind = "busy";
  else if (code === "bad_prompt" || code === "bad_composition_plan" || promptSuggestion || planSuggestion)
    kind = "bad_prompt";
  else if (status === 429 && code !== "quota_exceeded") kind = "busy";
  else if (status !== null && status >= 500) kind = "busy";
  else kind = "other";

  return { kind, status, code, promptSuggestion, planSuggestion, message };
}
