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
/** @typedef {import("@adc/shared/accounts/schemas").LedgerEntry} LedgerEntry */
/** @typedef {import("@adc/shared/accounts/schemas").TopUp} TopUp */
/** @typedef {import("@adc/shared/accounts/schemas").OutboxMail} OutboxMail */

// ───────────── Стан UI (заморожено) ─────────────

/**
 * `site` — хост із intake/project; `stageLog` — мітки progress поточного busy-стану;
 * `busyMs`/`busySince` — машинний час зі state-подій.
 * Гілки акаунтів (Крок 0 фронтенду акаунтів): `account`, `auth`, `cabinet`, `checkout`, `admin`,
 * `session` (системний стан сцени: 401 / 404 / 403), `projectCredits` (витрати відкритого проєкту
 * з `GET /api/projects/:id`, поле `credits`; немає — `null`).
 * @typedef {{
 *   route: Route["route"],
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
 *   ui: UiFlags,
 *   account: AccountState,
 *   auth: AuthState,
 *   cabinet: CabinetState,
 *   checkout: CheckoutState | null,
 *   admin: AdminState,
 *   session: "401" | "404" | "403" | null,
 *   projectCredits: ProjectCredits | null
 * }} UiState
 */

/**
 * `startShortage` — нестача на старті (клієнтська перевірка або 402 від `POST /api/projects`);
 * `retry` — картка «Баланс поповнено · Повторити» після повернення з оплати (кладе B8, знімає B6).
 * @typedef {{
 *   editing: boolean, draft: string, pendingFormats: Format[] | null, doneFormat: Format | null,
 *   notice: string | null, startError: string | null, sending: boolean,
 *   startShortage: { need: number, have: number } | null,
 *   retry: { ctx: "cp3" | "rev", plus: number, text: string | null } | null
 * }} UiFlags
 */

/**
 * Елемент стрічки; `id` = ID події SSE (дедуплікація).
 * @typedef {(
 *   | { kind: "message", id: string, at: string, role: "user" | "assistant" | "system", text: string, buttons: Button[] }
 *   | { kind: "progress", id: string, at: string, stage: string, label: string, done: number | null, total: number | null, running: boolean }
 *   | { kind: "checkpoint", id: string, at: string, checkpoint: Checkpoint, rev: number }
 *   | { kind: "error", id: string, at: string, stage: string | null, message: string, retryable: boolean }
 * )} FeedItem
 */

/** @typedef {{ rev: number, at: string, payload: CheckpointPayload, state: "open" | "approved" | "superseded" }} CheckpointEntry */

// ───────────── Акаунти (Крок 0 фронтенду акаунтів, заморожено) ─────────────

/**
 * Маршрут сторінки (URL ↔ Route — router.js).
 * @typedef {{ route: "start" } | { route: "project", projectId: string }
 *   | { route: "cabinet", section: CabinetState["section"] }
 *   | { route: "checkout", id: string }
 *   | { route: "admin", tab?: AdminState["tab"], userId?: string }} Route
 */

/**
 * Відповіді API акаунтів (розділ 10 ТЗ бекенду). `PublicUser.createdAt`/`activatedAt` — ISO.
 * @typedef {{ id: string, email: string, name: string, isAdmin: boolean, activatedAt: string | null, createdAt: string }} PublicUser
 * @typedef {{ id: string, credits: number, priceUsd: number, label: string }} CreditPackage
 * @typedef {{ video: number, revision: number, extraFormat: number }} CreditPrices
 * @typedef {{ user: PublicUser, balance: number, prices: CreditPrices, packages: CreditPackage[],
 *             custom: { min: number, max: number }, creditsPerUsd: number }} Me
 */

/**
 * Витрати кредитів по проєкту (B4): `parts` — від старіших до новіших, `credits` зі знаком леджера
 * (charge < 0, refund > 0); `charged` — сума модулів charge, `refunded` — сума refund.
 * @typedef {{ kind: "video" | "revision" | "format" | "refund", credits: number, format?: Format, rev?: number }} CreditPart
 * @typedef {{ charged: number, refunded: number, parts: CreditPart[] }} ProjectCredits
 */

/**
 * Рядок `GET /api/projects` (`?all=1` для адміна). `site` — адреса як її ввів клієнт (або null —
 * проєкт за описом); `credits: null` — безхазяйний проєкт (eval, до акаунтів). Поле `credits`
 * додає B4; бекенд без B4 його не віддає — читати як `row.credits ?? null`.
 * @typedef {{
 *   id: string, ownerId: string | null, createdAt: string | null, status: ProjectStatus,
 *   site: string | null, formats: Format[], totalUsd: number, chatUrl: string,
 *   credits: ProjectCredits | null
 * }} ProjectRow
 */

/**
 * Куди повернутися після оплати (sessionStorage `adc.return`, lib/pending.js).
 * @typedef {{ kind: "start" } | { kind: "project", projectId: string, host: string | null,
 *             retry: { ctx: "cp3" | "rev", text: string | null } | null } | { kind: "cabinet" }} ReturnTo
 */
/**
 * Відкладений старт гостя (localStorage `adc.pendingStart`, TTL 24 год від `at`; файли — лише в пам'яті модуля).
 * @typedef {{ url: string | null, manualText: string | null, hadPhotos: boolean, at: string }} PendingStart
 */

/**
 * `delta` — мітка «−3 / +10» у топбарі (анімація один раз на зміну `key`); `flash` — рядок-статус
 * на старті (вихід); `pending` — відкладений старт гостя; `autostart` — рядок «Починаю ролик…»;
 * `projectCount` — кількість проєктів для «Мої проєкти · N» (`null` — ще невідомо): ядро вантажить
 * `listProjects()`, коли `me` стає ready, і після успішного `createProject`; B9 може оновлювати
 * його з довжини `cabinet.projects.rows`;
 * `prices` — **єдине джерело цін для view** (і для гостя): ready → `me.prices`; гість → тихий
 * публічний `GET /api/billing/packages`; збій — `null` (view ховає ціну). Після виходу лишаються.
 * @typedef {{
 *   me: Me | null,
 *   meStatus: "loading" | "ready" | "anon",
 *   delta: { credits: number, key: number } | null,
 *   flash: string | null,
 *   pending: PendingStart | null,
 *   autostart: { host: string | null, charged: number, after: number, photosLost: boolean } | null,
 *   projectCount: number | null,
 *   prices: CreditPrices | null
 * }} AccountState
 */

/** @typedef {"login" | "register" | "check" | "activating" | "activated" | "activateInvalid"
 *   | "forgot" | "forgotSent" | "reset" | "resetInvalid" | "resetDone"} AuthView */
/** @typedef {"invalid_credentials" | "not_activated" | "rate_limited" | "network" | "empty" | "bad_email"
 *   | "empty_name" | "weak_password" | "invalid_token" | "google"} AuthError */
/**
 * Модалка входу; `null` — закрита. Посилання з листа (`/?auth=activate|reset&token=…`) Крок 0
 * перетворює на `view: "activating"` з `token` і викликає `submitAuth()` (той робить
 * `POST activate`) або на `view: "reset"` з `token` (новий пароль → `submitAuth()`).
 * Коли `route === "project" && session === "401"`, B1 модалку не показує: ту саму форму малює
 * сцена (B12, `mountAuthForm(el, ctx, { layout: "stage" })`) за цим самим станом (context `session`).
 * `message` — текст сервера (`message` з тіла відповіді) для поточного `error`; `null` — view бере
 * копірайт UI з кадру Референсу (`network`, `empty`, `bad_email`, `empty_name` тощо).
 * @typedef {{
 *   view: AuthView, context: "start" | "header" | "checkout" | "session" | null,
 *   name: string, email: string, password: string, showPassword: boolean,
 *   token: string | null, busy: boolean, error: AuthError | null, message: string | null, resent: boolean,
 *   cooldownUntil: number | null, bonus: number, fails: number
 * } | null} AuthState
 */

/**
 * `backTo` — банер повернення в «Баланс».
 * `history.topups` — карта `topupId → packageId` (`"custom"` — своя сума, як `TopUp.packageId`) для
 * назв «Поповнення · {пакет}» / «Поповнення · своя сума»; заповнює B9 з `listTopUps()` у `loadHistory`.
 * `profile.pwMessage` — текст сервера для `pwError === "weak_password"` (як `AuthState.message`);
 * `null` — копірайт UI з кадру.
 * @typedef {{
 *   section: "balance" | "history" | "projects" | "profile",
 *   loading: boolean,
 *   backTo: ReturnTo | null,
 *   topup: { mode: "package" | "custom", packageId: string | null, custom: string, error: boolean, busy: boolean },
 *   pendingTopups: TopUp[],
 *   history: { entries: LedgerEntry[], nextBefore: string | null, loading: boolean, more: boolean,
 *              topups: Record<string, string> },
 *   projects: { rows: ProjectRow[] | null, loading: boolean, open: string | null },
 *   profile: { nameDraft: string, saving: boolean, saved: boolean, nameError: boolean,
 *              current: string, next: string, pwBusy: boolean, pwError: "invalid_credentials" | "weak_password" | null,
 *              pwMessage: string | null, pwDone: boolean }
 * }} CabinetState
 */

/**
 * `error` — `GET topup` не вдався (мережа / 5xx) при першому завантаженні; `checkoutAgain()` у цьому
 * стані повторює завантаження того самого чека (адитивно до Кроку 0).
 * @typedef {{ status: "loading" | "pending" | "confirming" | "paid" | "failed" | "notfound" | "error",
 *   id: string, topup: TopUp | null, returnTo: ReturnTo, revisit: boolean }} CheckoutState
 */

/**
 * @typedef {{
 *   tab: "users" | "outbox" | "all", loading: boolean, forbidden: boolean,
 *   users: (PublicUser & { balance: number })[], q: string, selectedId: string | null,
 *   selected: { user: PublicUser, balance: number, entries: LedgerEntry[] } | null,
 *   adjust: { credits: string, note: string, busy: boolean, confirm: boolean,
 *             error: "zero" | "note" | { need: number, have: number } | null,
 *             done: { credits: number, note: string, balance: number } | null },
 *   outbox: OutboxMail[], copied: string | null, allProjects: ProjectRow[]
 * }} AdminState
 */

// ───────────── Дії ─────────────

/**
 * Дії проєкту (data/actions.js).
 * `setFormats` — debounce FORMATS_DEBOUNCE_MS → «Формати: 9:16, 1:1»; `setLanguage` → «Мова відео: en».
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
 *   startEdit(): void,
 *   setDraft(text: string): void,
 *   setDoneFormat(f: Format): void
 * }} ProjectActions
 */

/**
 * Дії акаунтів (заморожено). Ядро — data/account.js; решту реалізують part-файли
 * `data/<блок>-actions.js` — фабрики `(store, deps: PartDeps) => ({…})` рівно з цими ключами.
 * @typedef {{
 *   refreshMe(): Promise<void>, navigate(to: Route): void, logout(): Promise<void>,
 *   openAuth(view: AuthView, context?: NonNullable<AuthState>["context"]): void, closeAuth(): void,
 *   setAuthField(key: "name" | "email" | "password" | "showPassword", value: string | boolean): void,
 *   submitAuth(): Promise<void>, resendAuthMail(): Promise<void>, authGoogle(): Promise<void>,
 *   submitStart(form: FormData): Promise<void>, startPending(): Promise<void>, dismissFlash(): void,
 *   retryAfterTopup(): Promise<void>,
 *   openTopup(o: { from: "topbar" | "start" | "ws", ctx?: "cp3" | "rev", text?: string | null, packageId?: string, custom?: number }): void,
 *   selectPackage(id: string | "custom"): void, setCustom(value: string): void, submitTopup(): Promise<void>, continueTopup(id: string): void,
 *   confirmCheckout(outcome: "paid" | "failed"): Promise<void>, checkoutAgain(): Promise<void>, checkoutReturn(): void,
 *   loadHistory(more?: boolean): Promise<void>, loadProjects(): Promise<void>, toggleProjectCredits(id: string): void, openProject(id: string): void,
 *   setProfileField(key: "nameDraft" | "current" | "next", value: string): void, saveName(): Promise<void>, changePassword(): Promise<void>,
 *   adminTab(tab: AdminState["tab"]): void, adminSearch(q: string): void, adminSelect(id: string): Promise<void>,
 *   adminField(key: "credits" | "note", value: string): void, adminAdjust(confirmed?: boolean): Promise<void>,
 *   adminCancelConfirm(): void, adminCopy(mailId: string): Promise<void>
 * }} AccountActions
 */

/** Усі дії сторінки (`ctx.actions`). @typedef {ProjectActions & AccountActions} Actions */

/** @typedef {typeof import("./data/account-api.js")} AccountApi */

/**
 * Залежності part-фабрики `data/<блок>-actions.js`.
 * - `api` — data/account-api.js (тести підміняють);
 * - `actions()` — зібраний об'єкт усіх дій (лінивий: під час виклику фабрики ще не готовий);
 * - `backend` — джерело даних проєкту (`start(id)` / `stop()`);
 * - `offline` — `?mock=1`: мережі акаунтів немає, дії працюють лише на стані;
 * - `onRoute(fn)` — вхід у маршрут: ядро викликає `fn(route)` після кожного переходу (старт
 *   сторінки, `navigate`, `popstate`) і повторно після входу на захищеному маршруті — тут
 *   part-файл вантажить дані свого маршруту (B7 `GET topups`, B8 `GET topup`, B9, B11).
 * @typedef {{
 *   params: URLSearchParams,
 *   api: AccountApi,
 *   actions: () => Actions,
 *   backend: import("./data/actions.js").Backend,
 *   offline: boolean,
 *   onRoute(fn: (route: Route) => void): void
 * }} PartDeps
 */

/**
 * Фабрика part-файла: рівно ключі `K` з `AccountActions`.
 * @template {keyof AccountActions} K
 * @typedef {(store: Store, deps: PartDeps) => Pick<AccountActions, K>} PartFactory
 */

/**
 * Параметри шару даних: `createActions(store, opts)` з data/actions.js створює дії і сам запускає
 * потік даних для поточного маршруту (GET проєкту + SSE, або програвання фікстури при `?mock=1`).
 * `refreshMe` — оновити баланс після успішного старту проєкту (передає data/account.js).
 * @typedef {{ params: URLSearchParams, refreshMe?: () => Promise<void> }} DataOptions
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
/**
 * Екран сцени (права панель) — результат `viewFor`; `session` / `notfound` — системні стани
 * (`UiState.session` 401 / 404 мають пріоритет над статусом проєкту).
 * @typedef {"progress" | "brand" | "script" | "board" | "done" | "failed" | "session" | "notfound"} StageView
 */

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
