// @ts-check
/**
 * Заморожені контракти сторінки чату (Крок 0). Змінює лише власник Кроку 0 окремим PR.
 *
 * Типи подій і payload-ів беруться з `@adc/shared` лише для tsc (JSDoc), у браузер нічого
 * не імпортується: схеми бекенду й UI не можуть розійтися непомітно.
 */

/** @typedef {import("@adc/shared/schemas").Format} Format */
/** @typedef {import("@adc/shared/schemas").ProjectStatus} ProjectStatus */
/** @typedef {import("@adc/shared/schemas").Checkpoint} Checkpoint */
/** @typedef {import("@adc/shared/schemas").Button} Button */
/** @typedef {import("@adc/shared/schemas").ChatEvent} ChatEvent */
/** @typedef {import("@adc/shared/schemas").ChatEventType} ChatEventType */
/** @typedef {import("@adc/shared/schemas").CheckpointPayload} CheckpointPayload */
/** @typedef {Extract<CheckpointPayload, { checkpoint: "brand" }>} BrandCheckpointPayload */
/** @typedef {Extract<CheckpointPayload, { checkpoint: "script" }>} ScriptCheckpointPayload */
/** @typedef {Extract<CheckpointPayload, { checkpoint: "storyboard" }>} StoryboardCheckpointPayload */
/**
 * @template {ChatEventType} T
 * @typedef {Extract<ChatEvent, { type: T }>} EventOf
 */

// ───────────── Стан UI (заморожено) ─────────────

/**
 * `site` — хост із intake/project; `stageLog` — мітки progress поточного busy-стану;
 * `busyMs`/`busySince` — машинний час зі state-подій.
 * @typedef {{
 *   route: "start" | "project",
 *   projectId: string | null,
 *   site: string | null,
 *   status: ProjectStatus, prevStatus: ProjectStatus | null, rev: number | null,
 *   conn: "idle" | "online" | "reconnecting" | "lost",
 *   totalUsd: number, breakdown: { stage: string, usd: number }[] | null,
 *   feed: FeedItem[],
 *   progress: { stage: string, label: string, done: number | null, total: number | null } | null,
 *   stageLog: { stage: string, label: string }[],
 *   checkpoints: Record<Checkpoint, CheckpointEntry | null>,
 *   artifacts: { videos: { format: Format, url: string, rev: number }[], poster: string | null, music: string | null },
 *   error: { stage: string | null, message: string, retryable: boolean } | null,
 *   busyMs: number, busySince: string | null,
 *   ui: UiFlags
 * }} UiState
 */

/**
 * @typedef {{
 *   editing: boolean, draft: string, pendingFormats: Format[] | null, doneFormat: Format | null,
 *   notice: string | null, startError: string | null, sending: boolean
 * }} UiFlags
 */

/**
 * Елемент стрічки; `id` = ID події SSE (дедуплікація).
 * @typedef {
 *   | { kind: "message", id: string, at: string, role: "user" | "assistant" | "system", text: string, buttons: Button[] }
 *   | { kind: "progress", id: string, at: string, stage: string, label: string, done: number | null, total: number | null, running: boolean }
 *   | { kind: "checkpoint", id: string, at: string, checkpoint: Checkpoint, rev: number }
 *   | { kind: "error", id: string, at: string, stage: string | null, message: string, retryable: boolean }
 * } FeedItem
 */

/** @typedef {{ rev: number, at: string, payload: CheckpointPayload, state: "open" | "approved" | "superseded" }} CheckpointEntry */

// ───────────── Дії (реалізує B2 у data/actions.js) ─────────────

/**
 * `setFormats` — debounce FORMATS_DEBOUNCE_MS → «Формати: 9:16, 1:1»; `setLanguage` → «Мова відео: en»;
 * `answer` — опція питання бренд-кіта → текст як повідомлення.
 * @typedef {{
 *   createProject(form: FormData): Promise<void>,
 *   newProject(): void,
 *   sendMessage(text: string): Promise<boolean>,
 *   approve(): Promise<void>,
 *   retry(): Promise<void>,
 *   setLogo(assetId: string): Promise<void>,
 *   confirmRestart(): Promise<void>,
 *   uploadPhotos(files: FileList | File[]): Promise<void>,
 *   setFormats(formats: Format[]): void,
 *   setLanguage(lang: string): void,
 *   answer(text: string): void,
 *   startEdit(): void,
 *   setDraft(text: string): void,
 *   setDoneFormat(f: Format): void
 * }} Actions
 */

/**
 * Параметри шару даних: `createActions(store, opts)` з data/actions.js створює дії і сам запускає
 * потік даних для поточного маршруту (GET проєкту + SSE, або програвання фікстури при `?mock=1`).
 * @typedef {{ params: URLSearchParams }} DataOptions
 */

// ───────────── View ─────────────

/** @typedef {import("./store.js").Store<UiState>} Store */
/** @typedef {{ store: Store, actions: Actions }} Ctx */
/**
 * `update` патчить лише змінене: не перестворює `<video>`, `<audio>`, `<textarea>`
 * і не скидає скрол стрічки.
 * @typedef {{ update(state: UiState, prev: UiState): void, destroy(): void }} ViewHandle
 */
/** @typedef {(el: HTMLElement, ctx: Ctx) => ViewHandle} MountFn */
/** Екран сцени (права панель) — результат `viewFor`. @typedef {"progress" | "brand" | "script" | "board" | "done" | "failed"} StageView */

// ───────────── Константи (перенесені з попереднього index.html без змін) ─────────────

/** @type {readonly ChatEventType[]} */
export const EVENT_TYPES = ["message", "progress", "checkpoint", "artifact", "cost", "state", "error"];

/** @type {Record<Format, string>} */
export const FORMAT_LABELS = { vertical: "9:16", square: "1:1", landscape: "16:9" };

/** @type {Record<"user" | "assistant" | "system", string>} */
export const ROLE_LABELS = { user: "Ви", assistant: "AdCreative", system: "Система" };

/** @type {Record<ProjectStatus, string>} */
export const STATUS_LABELS = {
  intake: "прийнято",
  crawling: "сканую сайт",
  brandkit: "збираю бренд-кіт",
  awaiting_brand: "чекаю на погодження бренду",
  scripting: "пишу сценарій",
  awaiting_script: "чекаю на погодження текстів",
  directing: "генерую сцени і музику",
  awaiting_storyboard: "чекаю на погодження розкадровки",
  rendering: "рендерю",
  delivered: "готово",
  revising: "вношу правки",
  failed: "помилка",
};

/** @type {readonly ProjectStatus[]} */
export const AWAITING = ["awaiting_brand", "awaiting_script", "awaiting_storyboard"];

/** Стани, у яких іде робота (= `BUSY_STATUSES` з `@adc/shared`). @type {readonly ProjectStatus[]} */
export const BUSY = ["crawling", "brandkit", "scripting", "directing", "rendering", "revising"];

/** @type {Record<Checkpoint, string>} */
export const CHECKPOINT_TITLES = {
  brand: "Чекпоінт 1 — бренд",
  script: "Чекпоінт 2 — тексти",
  storyboard: "Чекпоінт 3 — розкадровка",
};

// ───────────── Нові ─────────────

/** Усі статуси проєкту в порядку пайплайна (= `PROJECT_STATUSES`). @type {readonly ProjectStatus[]} */
export const STATUSES = [
  "intake",
  "crawling",
  "brandkit",
  "awaiting_brand",
  "scripting",
  "awaiting_script",
  "directing",
  "awaiting_storyboard",
  "rendering",
  "delivered",
  "revising",
  "failed",
];

/** Канонічний порядок форматів; перший обраний — основний. @type {readonly Format[]} */
export const FORMATS = ["vertical", "square", "landscape"];

/** Статус очікування кожного чекпоінта. @type {Record<Checkpoint, ProjectStatus>} */
export const CHECKPOINT_STATUS = {
  brand: "awaiting_brand",
  script: "awaiting_script",
  storyboard: "awaiting_storyboard",
};

/**
 * @typedef {"site" | "brand" | "script" | "scenes" | "render" | "done"} SegmentKey
 * @typedef {{ key: SegmentKey, label: string, weight: number, checkpoint?: Checkpoint }} Segment
 */

/** Сегменти таймлайну (C3): ваги в сумі 6.7, ромби — на кінці сегментів з `checkpoint`. @type {readonly Segment[]} */
export const SEGMENTS = [
  { key: "site", label: "Сайт", weight: 1 },
  { key: "brand", label: "Бренд-кіт", weight: 1.3, checkpoint: "brand" },
  { key: "script", label: "Сценарій", weight: 1.2, checkpoint: "script" },
  { key: "scenes", label: "Сцени і музика", weight: 1.6, checkpoint: "storyboard" },
  { key: "render", label: "Рендер", weight: 1 },
  { key: "done", label: "Готово", weight: 0.6 },
];

/** Затримка надсилання «Формати: …» після останньої зміни (C6). */
export const FORMATS_DEBOUNCE_MS = 900;
