# ТЗ: фронтенд акаунтів, кабінету й кредитів — реалізація дизайну

Дата: 2026-10-20. Формат — parallel-ready: Крок 0 заморожує стан UI, маршрути, API-клієнт, спільні
бібліотеки й точки монтування; далі 12 блоків без спільних файлів у трьох хвилях по 4, потім інтеграція.

**Візуальний еталон:** `docs/design/AdCreative Accounts Reference.html` (самодостатній файл; копія
інтерактивного набору — `docs/design/AdCreative Accounts Reference.dc.html` + `Ac*.dc.html`, відкривати
через `npx serve docs/design`). Далі — «Референс». Кожен кадр має id стану (`#n1-login-invalid`); блок
робить dev-фікстуру з тим самим іменем, і приймання — це збіг `/?fixture=<ім’я>` з кадром.

**Затверджений набір:** N1–N2 — A (модалка) з полями B · N3 A · N4 B · N5 A · N6 A · N7 A · N8 B · N9 A ·
N10 A · N11 B · N12 B · N13 A · N14 A · N15 B.

Передумови: хвиля «auth-monetization» (бекенд) у `main`; `pnpm typecheck && pnpm lint && pnpm test`
зелені на `main`; контракт API ↔ UI — розділ 10 ТЗ бекенду
(`docs/superpowers/specs/2026-10-19-auth-monetization-tz.md`).

## 1. Мета і контекст

Бекенд акаунтів і кредитів готовий, інтерфейсу немає: сторінка чату (`apps/api/public/`, vanilla JS
модулі з `h()`, `createStore`, view `mount/update/destroy`, без збірки) досі не знає про користувачів.
Треба реалізувати затверджений дизайн: вхід і реєстрацію з активацією по листу, скидання пароля,
баланс у топбарі, ціни й нестачу кредитів на старті та в робочому просторі, кабінет (баланс і
поповнення, історія, проєкти, профіль), тестову оплату, адмінку та системні стани 401/403/404.
Плюс одна мала бекенд-доробка: витрати кредитів по проєкту (N12, N5 «оплачено»).

### 1.1 Що змінюється в наявних екранах (і лише це)

| Екран | Зміна | Блок |
|---|---|---|
| S1 старт (`start.js`) | шапка з «Увійти»/контролами акаунта; рядок ціни; K3; відкладений старт і автостарт; flash після виходу | B2 |
| C2 топбар (`topbar.js`) | пілюля балансу, меню акаунта; «Витрачено $» і «Статистика» — лише адміну; хост-слот «Кабінет»/«Адмінка» | B3 |
| ЧП1 (`cp-brand.js`) | теги цін на тайлах форматів, рядок «спишу на ЧП3» | B5 |
| ЧП3 (`cp-board.js`) | сума в «Затвердити й рендерити», рядок підсумку | B5 |
| Композер (`composer.js`) | підказка «правка — 3 кредити» після видачі | B5 |
| Чат (`chat.js`) | K3 під відмовою, картка «Повторити», сума в картці ЧП3 | B6 |
| Сцена (`view.js`) | нові екрани `session` / `notfound` | Крок 0 + B12 |

Усе інше в S1–S6 не чіпати.

### 1.2 Анти-цілі

Справжній Google OAuth і платіжний провайдер, зміна e-mail, видалення акаунта, редизайн `/stats`,
англійська версія, постер у картках проєктів (API не віддає — слот не робимо), нові npm-залежності,
збірка фронтенду.

## 2. Крок 0 — заморожені інтерфейси (окремий PR у `main`, робиться першим)

Поки Крок 0 не влитий, паралель не стартує. Власник Кроку 0 далі веде міні-PR у файлах із розділу 2;
блоки їх не правлять.

### 2.1 Стан UI — `public/static/js/contracts.js` (адитивно)

```js
/** Маршрут сторінки. */
// UiState.route: "start" | "project" | "cabinet" | "checkout" | "admin"

/**
 * @typedef {{ id: string, email: string, name: string, isAdmin: boolean, activatedAt: string | null, createdAt: string }} PublicUser
 * @typedef {{ id: string, credits: number, priceUsd: number, label: string }} CreditPackage
 * @typedef {{ video: number, revision: number, extraFormat: number }} CreditPrices
 * @typedef {{ user: PublicUser, balance: number, prices: CreditPrices, packages: CreditPackage[],
 *             custom: { min: number, max: number }, creditsPerUsd: number }} Me
 * @typedef {{ kind: "start" } | { kind: "project", projectId: string, host: string | null,
 *             retry: { ctx: "cp3" | "rev", text: string | null } | null } | { kind: "cabinet" }} ReturnTo
 * @typedef {{ url: string | null, manualText: string | null, hadPhotos: boolean, at: string }} PendingStart
 */

/**
 * @typedef {{
 *   me: Me | null,
 *   meStatus: "loading" | "ready" | "anon",
 *   delta: { credits: number, key: number } | null,      // мітка «−3 / +10» у топбарі
 *   flash: string | null,                                 // рядок-статус на старті (вихід)
 *   pending: PendingStart | null,                         // відкладений старт гостя
 *   autostart: { host: string | null, charged: number, after: number, photosLost: boolean } | null
 * }} AccountState
 */

/** @typedef {"login" | "register" | "check" | "activating" | "activated" | "activateInvalid"
 *   | "forgot" | "forgotSent" | "reset" | "resetInvalid" | "resetDone"} AuthView */
/** @typedef {"invalid_credentials" | "not_activated" | "rate_limited" | "network" | "empty" | "bad_email"
 *   | "empty_name" | "weak_password" | "invalid_token" | "google"} AuthError */
/**
 * null — модалка закрита.
 * @typedef {{
 *   view: AuthView, context: "start" | "header" | "checkout" | "session" | null,
 *   name: string, email: string, password: string, showPassword: boolean,
 *   token: string | null, busy: boolean, error: AuthError | null, resent: boolean,
 *   cooldownUntil: number | null, bonus: number, fails: number
 * } | null} AuthState
 */

/**
 * @typedef {{
 *   section: "balance" | "history" | "projects" | "profile",
 *   loading: boolean,
 *   backTo: ReturnTo | null,                                   // банер повернення в «Баланс»
 *   topup: { mode: "package" | "custom", packageId: string | null, custom: string, error: boolean, busy: boolean },
 *   pendingTopups: TopUp[],
 *   history: { entries: LedgerEntry[], nextBefore: string | null, loading: boolean, more: boolean },
 *   projects: { rows: ProjectRow[] | null, loading: boolean, open: string | null },
 *   profile: { nameDraft: string, saving: boolean, saved: boolean, nameError: boolean,
 *              current: string, next: string, pwBusy: boolean, pwError: "invalid_credentials" | "weak_password" | null, pwDone: boolean }
 * }} CabinetState
 */

/** @typedef {{ status: "loading" | "pending" | "confirming" | "paid" | "failed" | "notfound",
 *   id: string, topup: TopUp | null, returnTo: ReturnTo, revisit: boolean }} CheckoutState */

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

// UiState += { account: AccountState, auth: AuthState, cabinet: CabinetState,
//              checkout: CheckoutState | null, admin: AdminState, session: "401" | "404" | "403" | null,
//              projectCredits: ProjectRow["credits"] | null }
// UiFlags  += { startShortage: { need: number, have: number } | null,
//              retry: { ctx: "cp3" | "rev", plus: number, text: string | null } | null }
// ProjectRow / LedgerEntry / TopUp / OutboxMail — JSDoc-типи з @adc/shared (як ChatEvent)
// ProjectRow += credits (див. B4)
// StageView += "session" | "notfound"
```

`AccountActions` (заморожено; `Actions` = старі дії & `AccountActions`):

```js
/**
 * @typedef {{
 *   // ядро — Крок 0 (data/account.js)
 *   refreshMe(): Promise<void>, navigate(to: Route): void, logout(): Promise<void>,
 *   // B1 · data/auth-actions.js
 *   openAuth(view: AuthView, context?: AuthState["context"]): void, closeAuth(): void,
 *   setAuthField(key: "name" | "email" | "password" | "showPassword", value: string | boolean): void,
 *   submitAuth(): Promise<void>, resendAuthMail(): Promise<void>, authGoogle(): Promise<void>,
 *   // B2 · data/start-actions.js
 *   submitStart(form: FormData): Promise<void>, startPending(): Promise<void>, dismissFlash(): void,
 *   // B6 · data/retry-actions.js
 *   retryAfterTopup(): Promise<void>,
 *   // B7 · data/topup-actions.js
 *   openTopup(o: { from: "topbar" | "start" | "ws", ctx?: "cp3" | "rev", text?: string | null, packageId?: string, custom?: number }): void,
 *   selectPackage(id: string | "custom"): void, setCustom(value: string): void, submitTopup(): Promise<void>, continueTopup(id: string): void,
 *   // B8 · data/checkout-actions.js
 *   confirmCheckout(outcome: "paid" | "failed"): Promise<void>, checkoutAgain(): Promise<void>, checkoutReturn(): void,
 *   // B9 · data/cabinet-actions.js
 *   loadHistory(more?: boolean): Promise<void>, loadProjects(): Promise<void>, toggleProjectCredits(id: string): void, openProject(id: string): void,
 *   // B10 · data/profile-actions.js
 *   setProfileField(key: "nameDraft" | "current" | "next", value: string): void, saveName(): Promise<void>, changePassword(): Promise<void>,
 *   // B11 · data/admin-actions.js
 *   adminTab(tab: AdminState["tab"]): void, adminSearch(q: string): void, adminSelect(id: string): Promise<void>,
 *   adminField(key: "credits" | "note", value: string): void, adminAdjust(confirmed?: boolean): Promise<void>,
 *   adminCancelConfirm(): void, adminCopy(mailId: string): Promise<void>
 * }} AccountActions
 */
/** @typedef {{ route: "start" } | { route: "project", projectId: string } | { route: "cabinet", section: CabinetState["section"] }
 *   | { route: "checkout", id: string } | { route: "admin", tab?: AdminState["tab"], userId?: string }} Route */
```

### 2.2 URL і маршрутизація — `public/static/js/router.js` (новий, повна реалізація)

```js
/** URL ↔ Route. */
export function routeFromUrl(params: URLSearchParams): Route & { auth?: { kind: "activate" | "reset", token: string } };
export function urlForRoute(r: Route, params?: URLSearchParams): string; // зберігає mock/speed у mock-режимі
```

| URL | Маршрут |
|---|---|
| `/` | start |
| `/?project=<id>` | project |
| `/?cabinet=balance\|history\|projects\|profile` | cabinet |
| `/?checkout=<topupId>` | checkout (саме його повертає бекенд у `checkoutUrl`) |
| `/?admin=users\|outbox\|all[&user=<id>]` | admin |
| `/?auth=activate&token=…`, `/?auth=reset&token=…` | start + модалка; токен одразу прибирається з URL через `replaceState` |

`navigate()` (Крок 0) — `history.pushState` + `setState({route,…})`; `popstate` → той самий шлях.
Перехід project → інший маршрут викликає `backend.stop()` (SSE закривається), повернення — `start()`.

### 2.3 API-клієнт — `public/static/js/data/api.js` (зміна) і `data/account-api.js` (новий, повна реалізація)

- `api()` кидає `ApiError extends Error { status: number, code: string | null, body: any }`; `message` —
  як зараз (сумісно зі старими тестами). Мережева помилка → `ApiError { status: 0, code: "network" }`.
- `setUnauthorizedHandler(fn)` — викликається на кожен 401 з `code === "unauthorized"` (не на
  `invalid_credentials`).
- `account-api.js` — тонкі обгортки за розділом 10 ТЗ бекенду: `me, register, activate, resend, login,
  logout, forgot, reset, google, getAccount, patchAccount, changePassword, transactions({limit, before}),
  packages, createTopUp({packageId} | {credits}), listTopUps, getTopUp, confirmTopUp(id, outcome),
  adminUsers, adminUser, adminCredits(id, {credits, note}), adminTransactions, adminOutbox,
  listProjects({all})`. Кожна — `Promise<тіло>`; без логіки.

### 2.4 Ядро акаунта — `public/static/js/data/account.js` (новий)

`createAccountActions(store, { params, api? })`:
1. На старті — `GET /api/auth/me` → `account.me`, `meStatus: "ready"`; 401 → `"anon"`. У `?mock=1` і
   `?fixture=` — фейковий `me` (Олена, 12) без мережі.
2. `refreshMe()` — повторний `me`; якщо баланс змінився і `meStatus` уже був `ready` →
   `account.delta = { credits: new − old, key: Date.now() }`.
3. Підписка на store: нове повідомлення `assistant` у `feed`, яке розпізнає `parseCreditMessage` (2.6),
   → `refreshMe()`. Так топбар реагує на списання й повернення (N7-A).
4. `setUnauthorizedHandler`: `route === "project"` → `session: "401"` + `auth` у стані login/context
   session (форму малює сцена, B12); інші маршрути → `openAuth("login", "session")`.
5. `logout()` — `POST logout` → `me: null`, `meStatus: "anon"`, `navigate({route:"start"})`,
   `flash: "Ви вийшли з акаунта. Проєкти збережено — увійдіть, щоб продовжити."`.
6. Збирає `Object.assign(base, core, authActions(…), startActions(…), …)` з part-файлів. **Саме
   `Object.assign` на об’єкт `createActions`** — spread зламав би геттер `ready`.
7. Охорона маршрутів: cabinet/checkout/admin при `anon` → маршрут лишається, відкривається модалка
   login (context `checkout` для оплати, `header` для решти); після входу — дані маршруту
   перезавантажуються. admin при `!isAdmin` → `session: "403"`.

Part-файли `data/{auth,start,retry,topup,checkout,cabinet,profile,admin}-actions.js` у Кроці 0 —
фабрики `(store, deps) => ({…})` з рівно тими ключами з 2.1, тіла — `console.warn("[B?] not implemented")`.

### 2.5 Відкладений старт і повернення — `public/static/js/lib/pending.js` (новий, повна реалізація)

```js
export const PENDING_KEY = "adc.pendingStart";   // localStorage, JSON PendingStart, TTL 24 год від `at`
export const RETURN_KEY  = "adc.return";         // sessionStorage, JSON ReturnTo
export function savePending(p: PendingStart, files: File[]): void;  // файли — лише в пам’яті модуля
export function takePending(): { pending: PendingStart, files: File[] } | null; // читає й видаляє
export function peekPending(): PendingStart | null;
export function saveReturn(r: ReturnTo): void;
export function takeReturn(): ReturnTo | null;
```

`photosLost = pending.hadPhotos && files.length === 0` (сторінку перезавантажили — лист відкрито в
новій вкладці).

`adc.pendingStart` — у **localStorage з TTL 24 год** (рішення користувача 2026-10-20): посилання з
листа відкривається в новій вкладці, куди sessionStorage не переходить. Протухлий або битий запис
видаляється, `peekPending`/`takePending` → `null`. `adc.return` лишається в sessionStorage
(повернення після оплати — у тій самій вкладці).

### 2.6 Спільні бібліотеки — `lib/credits.js`, `lib/credit-messages.js` (нові, повна реалізація)

```js
// lib/credits.js
export function creditWord(n: number): "кредит" | "кредити" | "кредитів"; // 1 · 2–4 · 5–20; 11–14 → кредитів
export function formatNumber(n: number): string;         // тисячі через U+00A0
export function formatCredits(n: number): string;        // "1 250 кредитів" (U+00A0 перед словом)
export function signed(n: number): string;               // "−10" (U+2212) | "+25" | "0"
export function plural(n: number, forms: [string, string, string]): string;
export function enoughFor(n: number, prices: CreditPrices): string; // "1 ролик або 4 правки" | "4 правки, на ролик — ні" | "ні на ролик, ні на правку"
export function isLow(balance: number, prices: CreditPrices): boolean; // balance < prices.video * 0.5
export function closingPackage(packages: CreditPackage[], short: number): CreditPackage; // найменший ≥ short, інакше найбільший
export function customFor(short: number, custom: { min: number }): number; // max(short, min)
export function extraFormatsCharge(formats: Format[], paid: Format[], prices: CreditPrices):
  { need: number, extra: Format[], paid: Format[] };   // перший формат — у ціні
export function paidFormats(row: ProjectRow | null): Format[]; // з credits.parts kind "format"

// lib/credit-messages.js — регекспи з текстів packages/shared/src/i18n/uk.ts (дослівно)
export function parseCreditMessage(text: string):
  | { kind: "insufficient", need: number, have: number }
  | { kind: "insufficientFormats", need: number, have: number }
  | { kind: "chargedRevision", credits: number, balance: number }
  | { kind: "chargedFormats", credits: number, count: number, balance: number }
  | { kind: "refunded", credits: number }
  | null;
```

### 2.7 Спільний компонент K3 — `views/shortage.js` + `css/shortage.css` (повна реалізація)

```js
export function shortageCard(o: {
  title: string,                        // «Не вистачає кредитів» | «Не вистачає на правку» | «Не вистачає на формати»
  need: number, have: number, size: "start" | "chat",
  advice: string,
  primary: { label: string, onClick(): void },
  secondary?: { label: string, onClick(): void },
}): HTMLElement;
```

Розміри — Референс `#K` і `#n3-402`, `#n7-fmt-short`. `role="alert"`.

### 2.8 Токени — `css/tokens.css` (+4)

```css
--scrim: rgba(21, 20, 18, 0.32);        /* підкладка модалки входу */
--veil: rgba(245, 243, 238, 0.78);      /* резерв для оверлеїв */
--danger-field: rgba(184, 51, 31, 0.55);/* рамка поля-картки з помилкою */
--ac-delta: 1.6s;                        /* мітка зміни балансу */
```

+ `@keyframes ac-delta` і `ac-scrim` у `base.css` (з reduced-motion-версією — лише opacity).

### 2.9 Точки монтування — `public/index.html`, `js/app.js`, `js/view.js`, `js/initial.js`

```html
<div id="app" data-route="start">
  <section id="start"></section>
  <div id="workspace" hidden> …як зараз… </div>
  <div id="cabinet" hidden><header id="cab-topbar"></header><div id="cab-main"></div></div>
  <section id="checkout" hidden></section>
  <div id="admin" hidden><header id="admin-topbar"></header><div id="admin-main"></div></div>
  <div id="overlay"></div>          <!-- модалка входу (B1), завжди змонтована -->
</div>
```

+ `<link>` на `auth.css, account.css, shortage.css, cabinet.css, cab-balance.css, cab-history.css,
cab-projects.css, cab-profile.css, checkout.css, admin.css, session.css` (у Кроці 0 — порожні файли
з коментарем-власником).

`app.js`: рендер нових маршрутів (topbar.mount у `#cab-topbar` і `#admin-topbar`; `cabinet.mount` у
`#cab-main`; `checkout.mount`; `admin.mount`; `auth.mount` у `#overlay` один раз). `view.js`:
`session === "401"` → `"session"`, `"404"` → `"notfound"` (перевіряється до статусу). `initial.js`:
дефолти нових гілок. `data/actions.js` (зміни Кроку 0): `getProject` 404 → `session: "404"`;
`createProject` — 402 → `ui.startShortage = {need: required, have: available}`, успіх → `refreshMe()`.

### 2.10 Заглушки view і фікстури

- `views/{auth,account-controls,cabinet,cab-balance,cab-history,cab-projects,cab-profile,checkout,admin,session}.js`
  — `stubView(...)` з `dev/stub.js`, з фіксованими експортами:
  `auth.js: mount, mountAuthForm(el, ctx, { layout: "modal" | "stage" })`;
  `account-controls.js: mount(el, ctx, { place: "start" | "page" })` (пілюля + коло + меню);
  `cabinet.js: mount` (сам монтує розділи `cab-*.js`); решта — `mount`.
- `dev/fixtures/{auth,start,topbar,workspace,chat,cabinet,checkout,history,projects,profile,admin,session}.js`
  — `export default {}`; `dev/fixture-states.js` спредить їх у `fixtureStates`. Кожен блок наповнює лише
  свій файл, імена — з карти станів Референсу (`#M`).
- `dev/dev-actions.js` — усі `AccountActions` як no-op із `console.info`.
- `dev/fixtures/_base.js` (Крок 0, повна реалізація) — `accountFixture(patch)`: дані розділу 8 ТЗ
  дизайну (Олена, історія з 11 записів, 4 проєкти з `credits`, користувачі адмінки, outbox) — щоб
  блоки не дублювали дані.

### 2.11 Тести Кроку 0

`apps/api/test/ui/account-core.test.ts`: `creditWord` для 0,1,2,4,5,11,12,14,21,22,25,111,1250;
`formatCredits(1250)` з U+00A0; `signed`; `enoughFor`; `isLow(4|5)`; `closingPackage` (6 → «Старт»,
11 → «Кілька роликів», 999 → «Серія»); `extraFormatsCharge` (один формат → 0; оплачений не рахується);
`parseCreditMessage` на кожному з п’яти шаблонів `uk.ts` (імпорт `t()` з `@adc/shared`, щоб тест
падав, якщо шаблон зміниться) і на звичайному тексті → null; `routeFromUrl/urlForRoute` для всіх рядків
2.2; `ApiError` (status/code/message, network); `pending.js` round-trip і `photosLost`;
`refreshMe` ставить `delta`; 401-хендлер на project → `session "401"`; `Object.assign` зберігає
`ready`; `shortageCard` (тексти, ролі, кліки). Плюс `contracts.test.ts`, `integration.test.ts` —
оновити під нові поля (власник Кроку 0).

```bash
pnpm typecheck && pnpm lint
pnpm --filter @adc/api exec vitest run test/ui/account-core.test.ts test/ui/contracts.test.ts test/ui/integration.test.ts
pnpm --filter @adc/api exec vitest run test/ui      # наявні UI-тести зелені з заглушками
```

## 3. Блоки робіт

Кожен блок: реалізація + стилі + фікстури + тести. Візуальні значення — Референс (розділ N блоку:
«Розміри й правила» + кадри). Класи CSS — з префіксом блоку; тексти — з кадрів дослівно; серверні
тексти — з відповіді (`message`), не з коду.

### Хвиля 1

#### B1: Вхід, реєстрація, листи (N1–N2)

- **Володіє:** `views/auth.js`, `css/auth.css` (`.au-`), `data/auth-actions.js`, `dev/fixtures/auth.js`,
  `test/ui/auth.test.ts`.
- **Залежить від:** Крок 0 (стан `auth`, `account-api`, `pending.js`, `refreshMe`, `startPending` як
  виклик через `ctx.actions`).
- **Поведінка:**
  - Модалка в `#overlay`: підкладка `--scrim`, картка 560/44/20 (390 — повноекранна). Пастка фокусу,
    Esc і клік по підкладці = «Закрити» (не в `activating`, не в контексті `session`), фокус на першому
    полі, повернення фокусу на тригер. `mountAuthForm(el, ctx, {layout:"stage"})` — та сама форма без
    картки для B12.
  - Перегляди й тексти — Референс `#N1`, аркуші `sheet-n1`, `sheet-n2`. Помилки сервера показуються
    `message` з відповіді; `network`, `empty`, `bad_email`, `empty_name` — копірайт UI з кадрів.
  - `register` → завжди `check` (202 enumeration-safe); `cooldownUntil = now + 60 с`, таймер «0:42»;
    `resend` → `resent: true`. `login` 403 `not_activated` → посилання «Надіслати лист ще раз».
    429 → кнопка disabled. `google` → 501 → рядок-статус.
  - Посилання з листа: Крок 0 передає `auth: {kind, token}` → `activating` → `POST activate` →
    `refreshMe()` → є `peekPending()` і `balance ≥ prices.video` → `closeAuth()` + `startPending()`;
    є pending, але не вистачає → `activated` з карткою «Не вистачає на ролик» і «Поповнити»
    (`openTopup({from:"start"})`); без pending → `activated` з «На старт» / «До кабінету».
    `invalid_token` → `activateInvalid` (форма e-mail → `resend`).
  - `reset` → `resetDone` («До кабінету» / «На старт»); `invalid_token` → `resetInvalid`.
  - Успішний login: context `session` на маршруті project → `session: null` + перезапуск потоку
    (`backend.start`); `checkout` → перезавантажити чек; є pending → `startPending()`.
- **Критерії приймання:** фікстури всіх 29 станів N1–N2 з карти Референсу збігаються з кадрами на
  1440 і 390; повний цикл register → check → (токен) → activated на стабі `fetch`; відповідь сервера
  401/403/429/400 показує його `message`; клавіатура: Tab по колу всередині модалки, Enter надсилає,
  Esc закриває; автозаповнення (`autocomplete` username/current-password/new-password); токен
  прибирається з URL.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/auth.test.ts`
- **Паралельність:** з B2, B3, B4.

#### B2: Старт для гостя й користувача, автостарт (N3-A)

- **Володіє:** `views/start.js`, `css/start.css`, `data/start-actions.js`, `dev/fixtures/start.js`,
  `test/ui/start.test.ts` (оновлення наявного).
- **Залежить від:** Крок 0 (`account`, `pending.js`, `shortageCard`, `lib/credits.js`,
  `account-controls.mount` — заглушка до B3).
- **Поведінка:** шапка старту (гість — ghost «Увійти» 32/44 на 390 → `openAuth("login","header")`;
  користувач — `account-controls.mount(el, ctx, {place:"start"})`). Рядок ціни, рядок нестачі з
  «поповнити», `ui.startShortage` → `shortageCard` (size start). `submitStart(form)`: гість →
  `savePending(...)` + `openAuth("register","start")`; `balance < prices.video` → `startShortage` без
  запиту; інакше → `createProject(form)`. `startPending()`: `takePending()` → форма з url/manualText
  + файли → `autostart = {host, charged, after, photosLost}` → `createProject` → маршрут project
  (рядок «Починаю ролик…» видно, поки йде запит, мін. 1.2 с); 402 → `startShortage`. `photosLost` —
  лише рядок на старті (кадр `#n3-auto`), без повідомлення в чаті. Flash після виходу;
  «Мої проєкти · N».
- **Критерії приймання:** фікстури `n3-guest, n3-guest-url, n3-user, n3-low, n3-402, n3-auto,
  n3-empty, n15-logout` збігаються з кадрами на 1440 і 390; гість → pending у localStorage і
  модалка register; клієнтська перевірка не робить запиту; 402 від сервера дає ту саму картку;
  наявні тести старту зелені (адаптовані).
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/start.test.ts`
- **Паралельність:** з B1, B3, B4.

#### B3: Топбар, пілюля балансу, меню акаунта (N4-B)

- **Володіє:** `views/topbar.js`, `views/account-controls.js`, `css/chrome.css` (лише топбар-частина;
  таймлайн не чіпати), `css/account.css` (`.ac-`), `dev/fixtures/topbar.js`, `test/ui/topbar.test.ts`
  (оновлення), `test/ui/account-controls.test.ts`.
- **Залежить від:** Крок 0 (`account`, `lib/credits.js`, `navigate`, `logout`, `openTopup` — заглушка до B7).
- **Поведінка:** Референс `#N4`. Стан меню — локальний у view (не в store). «Витрачено $» і
  «Статистика» — лише `isAdmin`. Хост-слот: project — хост; cabinet — «Кабінет»; admin — «Адмінка»;
  статус проєкту — лише на project. Мітка `delta` — анімація `ac-delta` один раз на зміну `key`.
  Пункти меню: Кабінет → cabinet/balance; Мої проєкти · N → cabinet/projects; Історія; Профіль;
  адмін — Адмінка → admin/users, Статистика ↗ → `/stats`; Вийти → `logout()`.
- **Критерії приймання:** аркуш `sheet-n4` (12 станів) + `n4-menu`, `n4-admin`, `ws-meload`,
  `ws-long` на 1440 і 1024 без переносів; клавіатура меню (Enter/Space/↑/↓/Esc, повернення фокусу);
  клік поза меню закриває; клієнт не бачить `$` і `/stats`.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/topbar.test.ts test/ui/account-controls.test.ts`
- **Паралельність:** з B1, B2, B4.

#### B4 (бекенд): витрати кредитів по проєкту

- **Володіє:** `apps/api/src/routes/projects.ts`, новий `apps/api/test/project-credits.test.ts`.
- **Залежить від:** нічого з фронтенду; `AccountStore.readLedger` уже є.
- **Поведінка:** `GET /api/projects` (рядки) і `GET /api/projects/:id` отримують
  `credits: { charged: number, refunded: number, parts: { kind: "video" | "revision" | "format" | "refund", credits: number, format?: Format, rev?: number }[] }`
  — записи леджера власника з `ref.projectId === id` (для admin `?all=1` — леджер власника проєкту;
  без `ownerId` — `null`). `charged` — сума модулів charge, `refunded` — сума refund; `parts` у
  хронологічному порядку. Один `readLedger` на користувача на запит (не на рядок).
- **Критерії приймання:** проєкт «zerno» з розділу 8 ТЗ дизайну → `charged 15, refunded 0`, три parts;
  збій з поверненням → `10 / 10`; чужий леджер не читається; безхазяйний → `credits: null`; існуючі
  тести `projects.test.ts` без змін очікувань. Доповнити розділ 10 ТЗ бекенду рядком контракту.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/project-credits.test.ts test/projects.test.ts`
- **Паралельність:** з B1, B2, B3.

### Хвиля 2

#### B5: Ціни в робочому просторі (N5-A)

- **Володіє:** `views/cp-brand.js`, `views/cp-board.js`, `views/composer.js`, `css/cp-brand.css`,
  `css/cp-board.css` (сюди ж — стилі підказки композера `.cmp-price`; `css/chat.css` належить B6),
  `dev/fixtures/workspace.js`, `test/ui/{cp-brand,cp-board,composer}.test.ts` (оновлення).
- **Залежить від:** Крок 0 (`lib/credits.js`: `extraFormatsCharge`, `paidFormats`; `account.me`),
  B4 — лише в даних (`project.credits`); у фікстурах і тестах — зі `_base.js`. Паралельно з B4 не
  потрібна.
- **Поведінка:** Референс `#N5`. Оплачені формати — `paidFormats(state.projectCredits)`
  (`UiState.projectCredits` заповнює Крок 0 у `backend.start` з `GET /api/projects/:id`).
  «поповнити» → `openTopup({from:"ws", ctx:"cp3"})`.
- **Критерії приймання:** фікстури `n5-cp1, n5-cp1-short, n5-cp1-one, n5-cp3, n5-cp3-short,
  n5-cp3-paid, n5-cp3-one, n5-done, n5-done-short, n5-done-typing` на 1440 і 1024; надсилання правки
  не блокується за будь-якого балансу.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/cp-brand.test.ts test/ui/cp-board.test.ts test/ui/composer.test.ts`
- **Паралельність:** з B6, B7, B8.

#### B6: Кредити в чаті — K3, «Повторити», ЧП3 (N6-A, N7-A)

- **Володіє:** `views/chat.js`, `css/chat.css`, `data/retry-actions.js`, `dev/fixtures/chat.js`,
  `test/ui/chat.test.ts` (оновлення), `test/ui/retry.test.ts`.
- **Залежить від:** Крок 0 (`parseCreditMessage`, `shortageCard`, `closingPackage`, `ui.retry`,
  `pending.js` `saveReturn`).
- **Поведінка:** Референс `#N6`. Повідомлення — дослівно; після `insufficient*` — `shortageCard`
  (size chat) з «Поповнити» → `openTopup({from:"ws", ctx, text})` (`text` — останнє повідомлення
  користувача перед відмовою, для `rev`) і «Лишити один формат» → `setFormats([formats[0]])`.
  `ui.retry` (кладе B8 при поверненні) → картка «Баланс поповнено · +N · тепер M» +
  «Повторити» → `retryAfterTopup()`: cp3 → `approve()`; rev → `sendMessage(text)`; після успіху
  `ui.retry = null`. Картка ЧП3 у чаті — «Затвердити · N кредитів» і «правки до видачі — безкоштовно».
- **Критерії приймання:** фікстури `n7-fmt-short, n7-rev-short, n6-retry, n6-retry-rev, n7-rev,
  n7-fmt, n7-refund` на 1440 і 1024; K3 з’являється лише під останньою відмовою (старі відмови в
  історії — без картки, якщо після них уже була успішна дія того ж типу).
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/chat.test.ts test/ui/retry.test.ts`
- **Паралельність:** з B5, B7, B8.

#### B7: Кабінет — каркас, баланс, поповнення (N8-B, N9-A)

- **Володіє:** `views/cabinet.js`, `views/cab-balance.js`, `css/cabinet.css` (`.cab-`),
  `css/cab-balance.css`, `data/topup-actions.js`, `dev/fixtures/cabinet.js`,
  `test/ui/{cabinet,cab-balance,topup}.test.ts`.
- **Залежить від:** Крок 0 (`cabinet`, `navigate`, `account-api`, `pending.js`, `lib/credits.js`;
  розділи `cab-history/projects/profile` — заглушки до B9/B10).
- **Поведінка:** Референс `#N8`. `openTopup(o)`: `saveReturn(...)` (start → `{kind:"start"}`; ws →
  `{kind:"project", projectId, host, retry:{ctx, text}}`; topbar → `{kind:"cabinet"}`) +
  `navigate({route:"cabinet", section:"balance"})` + передвибір (`packageId` або
  `closingPackage(short)`; `custom` → режим custom). Банер повернення — з `cabinet.backTo`.
  `submitTopup()` → валідація custom (ціле, `custom.min…max`) → `POST topups` →
  `navigate({route:"checkout", id})`. Незавершені — `GET topups` зі статусом pending →
  «Продовжити оплату» → чек. Навігація лівої колонки — `navigate` по розділах; «← до host» — назад у
  проєкт.
- **Критерії приймання:** фікстури `cab-balance, cab-zero, n6-start-return, n6-cab-return,
  cab-from-ws, cab-loading, cab-admin` і аркуш `sheet-n9` (13 станів, у т.ч. 1 і 5 пакетів) на 1440
  і 1024; помилки custom — три тексти; `min-width 1024`.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/cabinet.test.ts test/ui/cab-balance.test.ts test/ui/topup.test.ts`
- **Паралельність:** з B5, B6, B8.

#### B8: Тестова оплата (N10-A)

- **Володіє:** `views/checkout.js`, `css/checkout.css` (`.co-`), `data/checkout-actions.js`,
  `dev/fixtures/checkout.js`, `test/ui/checkout.test.ts`.
- **Залежить від:** Крок 0 (`checkout`, `account-api`, `pending.js`, `navigate`, `refreshMe`,
  `startPending` через `ctx.actions`).
- **Поведінка:** Референс `#N10`. Вхід на маршрут → `GET topup` (`loading` → `pending` /
  `paid|failed` з `revisit: true` / 404 → `notfound`). `returnTo` = `takeReturn()` при першому
  відкритті (і тримається в стані), інакше `{kind:"cabinet"}`. `confirmCheckout("paid")` →
  `confirming` → `POST confirm` → `refreshMe()` → `paid`; далі start → рядок «Повертаю на старт…» і
  через 1.4 с `navigate(start)` + `startPending()`; project → кнопка «Повернутися до проєкту» →
  `navigate(project)` + `ui.retry = {ctx, plus: credits, text}`; cabinet → «До кабінету».
  `failed` → «Спробувати ще раз» (`POST topups` з тим самим пакетом/сумою → новий чек).
- **Критерії приймання:** аркуш `sheet-n10` (9 станів) + `n10-pending`, `n10-paid-start` на 390;
  повторне відкриття paid не робить `confirm`; кнопки disabled під час confirming; гість → модалка
  (B1) з контекстом checkout.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/checkout.test.ts`
- **Паралельність:** з B5, B6, B7.

### Хвиля 3

#### B9: Історія і мої проєкти (N11-B, N12-B)

- **Володіє:** `views/cab-history.js`, `views/cab-projects.js`, `css/cab-history.css`,
  `css/cab-projects.css`, `data/cabinet-actions.js`, `dev/fixtures/{history,projects}.js`,
  `test/ui/{cab-history,cab-projects}.test.ts`.
- **Залежить від:** Крок 0, B4 (`credits` у рядках; у тестах — стаб).
- **Поведінка:** Референс `#N11`. Назви операцій — з `kind` + `ref` (таблиця в Референсі); хост
  проєкту в рядку історії — з `projects` (рахує фронтенд); день — за локальною датою; підсумок дня —
  сума `credits`, «на кінець» — `balanceAfter` найновішого запису дня. `loadHistory(true)` —
  `before = nextBefore`. Картки без постера.
- **Критерії приймання:** аркуші `sheet-n11`, `sheet-n12` + `cab-history`, `cab-projects` на 1440 і
  1024; пагінація без дублів; розбивка `10 − 10 = 0`; 12 проєктів без переносів у підписах форматів і
  «за день».
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/cab-history.test.ts test/ui/cab-projects.test.ts`
- **Паралельність:** з B10, B11, B12.

#### B10: Профіль і пароль (N13-A)

- **Володіє:** `views/cab-profile.js`, `css/cab-profile.css`, `data/profile-actions.js`,
  `dev/fixtures/profile.js`, `test/ui/cab-profile.test.ts`.
- **Залежить від:** Крок 0.
- **Поведінка:** Референс `#N13`. `saveName` → `PATCH /api/account` → `refreshMe()`;
  `changePassword` → `POST /api/account/password` (401 → `pwError: invalid_credentials`, 400 weak) →
  `pwDone`. «Вийти з акаунта» → `logout()`.
- **Критерії приймання:** аркуш `sheet-n13` (9 станів) + `cab-profile`; автозаповнення пароля
  (прихований username).
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/cab-profile.test.ts`
- **Паралельність:** з B9, B11, B12.

#### B11: Адмінка (N14-A)

- **Володіє:** `views/admin.js`, `css/admin.css` (`.adm-`), `data/admin-actions.js`,
  `dev/fixtures/admin.js`, `test/ui/admin.test.ts`.
- **Залежить від:** Крок 0 (`admin`, `account-api`).
- **Поведінка:** Референс `#N14`. Поріг підтвердження: списання ≥ 20 або > 50% балансу.
  `adminAdjust` → `POST /api/admin/users/:id/credits` (402 → `{need, have}`) → новий запис зверху,
  `done`. «Копіювати» — `navigator.clipboard.writeText(link)` → `copied` на 2 с. «Відкрити ↗» —
  `window.open(link, "_blank", "noopener")`. Усі проєкти — `listProjects({all:true})`, власник —
  e-mail з `users` за `ownerId`.
- **Критерії приймання:** фікстури `adm-users, adm-user, adm-done, adm-confirm, adm-402, adm-outbox,
  adm-all, adm-search, adm-empty, adm-loading` на 1440; пошук фільтрує на клієнті без запиту.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/admin.test.ts`
- **Паралельність:** з B9, B10, B12.

#### B12: Системні стани в сцені (N15-B)

- **Володіє:** `views/session.js`, `css/session.css` (`.ss-`), `dev/fixtures/session.js`,
  `test/ui/session.test.ts`.
- **Залежить від:** Крок 0 (`session`, `view.js`), B1 (`mountAuthForm` — вже в main після хвилі 1).
- **Поведінка:** Референс `#N15`. STAGE_VIEWS `session` → форма входу layout stage; `notfound` →
  X4-стан з «Мої проєкти» / «Новий проєкт»; 403 — `mountForbidden(el, ctx)`, яку `admin.js` (B11)
  викликає при `admin.forbidden`; текст порожнього чату для 404 — `emptyChatText(state)`, яку
  `chat.js` (B6) показує, якщо вона не `null`. Обидві функції заморожені заглушками в Кроці 0.
- **Критерії приймання:** фікстури `n15-401, n15-401-err, n15-404, n15-403, n15-net` на 1440 і 1024;
  після входу в 401 проєкт перезавантажується на тому ж екрані.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/session.test.ts`
- **Паралельність:** з B9, B10, B11.

### Хвиля 4 — B13: Інтеграція

- **Володіє:** `apps/api/test/ui/accounts-flows.test.ts` (наскрізні F1–F5 на стабі `fetch` +
  happy-dom), `README.md` (розділ «Інтерфейс акаунтів»), `docs/design/` (Референс і `.dc.html`-джерела),
  розділ 11 цього ТЗ.
- **Поведінка:** F1–F5 з Референсу `#F` проходять кліками; ручний прохід із розділу 10 на живому
  бекенді.

## 4. Карта володіння файлами

Шлях `public/static/` скорочено; тести — `apps/api/test/ui/`.

| Блок | Файли |
|---|---|
| Крок 0 | `js/contracts.js`, `js/app.js`, `js/view.js`, `js/initial.js`, `js/router.js`, `js/data/{api,account-api,account,actions}.js`, порожні `js/data/{auth,start,retry,topup,checkout,cabinet,profile,admin}-actions.js`, `js/lib/{credits,credit-messages,pending}.js`, `js/views/shortage.js`, заглушки `js/views/{auth,account-controls,cabinet,cab-balance,cab-history,cab-projects,cab-profile,checkout,admin,session}.js`, `css/{tokens,base,shortage}.css`, порожні нові css, `index.html`, `dev/{fixture-states,dev-actions}.js`, `dev/fixtures/_base.js` + порожні `dev/fixtures/*.js`, тести `account-core`, `contracts`, `integration` |
| B1 | `js/views/auth.js`, `css/auth.css`, `js/data/auth-actions.js`, `dev/fixtures/auth.js`, `auth.test.ts` |
| B2 | `js/views/start.js`, `css/start.css`, `js/data/start-actions.js`, `dev/fixtures/start.js`, `start.test.ts` |
| B3 | `js/views/{topbar,account-controls}.js`, `css/{chrome,account}.css`, `dev/fixtures/topbar.js`, `{topbar,account-controls}.test.ts` |
| B4 | `apps/api/src/routes/projects.ts`, `apps/api/test/project-credits.test.ts` |
| B5 | `js/views/{cp-brand,cp-board,composer}.js`, `css/{cp-brand,cp-board}.css`, `dev/fixtures/workspace.js`, `{cp-brand,cp-board,composer}.test.ts` |
| B6 | `js/views/chat.js`, `css/chat.css`, `js/data/retry-actions.js`, `dev/fixtures/chat.js`, `{chat,retry}.test.ts` |
| B7 | `js/views/{cabinet,cab-balance}.js`, `css/{cabinet,cab-balance}.css`, `js/data/topup-actions.js`, `dev/fixtures/cabinet.js`, `{cabinet,cab-balance,topup}.test.ts` |
| B8 | `js/views/checkout.js`, `css/checkout.css`, `js/data/checkout-actions.js`, `dev/fixtures/checkout.js`, `checkout.test.ts` |
| B9 | `js/views/{cab-history,cab-projects}.js`, `css/{cab-history,cab-projects}.css`, `js/data/cabinet-actions.js`, `dev/fixtures/{history,projects}.js`, `{cab-history,cab-projects}.test.ts` |
| B10 | `js/views/cab-profile.js`, `css/cab-profile.css`, `js/data/profile-actions.js`, `dev/fixtures/profile.js`, `cab-profile.test.ts` |
| B11 | `js/views/admin.js`, `css/admin.css`, `js/data/admin-actions.js`, `dev/fixtures/admin.js`, `admin.test.ts` |
| B12 | `js/views/session.js`, `css/session.css`, `dev/fixtures/session.js`, `session.test.ts` |
| B13 | `accounts-flows.test.ts`, `README.md`, `docs/design/**`, розділ 11 ТЗ |

**Міжблокові точки (заморожені в Кроці 0):**
- `UiState.projectCredits: ProjectRow["credits"] | null` — заповнює Крок 0 у `backend.start`.
- `views/session.js` експортує `mount`, `mountForbidden(el, ctx)`, `emptyChatText(state): string | null`;
  `chat.js` (B6) і `admin.js` (B11) імпортують їх, тіла робить B12.
- `views/auth.js` експортує `mountAuthForm` для B12; `views/account-controls.js` — `mount` для B2, B8.

**Спільні файли — один власник:** `contracts.js`, `app.js`, `view.js`, `initial.js`, `router.js`,
`data/{api,actions,account,account-api}.js`, `lib/**`, `views/shortage.js`, `tokens.css`, `base.css`,
`index.html`, `dev/fixture-states.js`, `dev/dev-actions.js`, `dev/fixtures/_base.js` → **Крок 0**.
Потрібна зміна з блоку — міні-PR власника Кроку 0, не правка в гілці блоку. `views/timeline.js`,
`stage-progress.js`, `done.js`, `failed.js`, `cp-script.js`, `data/{reduce,sse,mock}.js` → не чіпати.
`packages/**`, решта `apps/api/src/**` → не чіпати (крім B4). `package.json`, `pnpm-lock.yaml` → без змін.

Перевірка перетинів: кожен view, css, part-actions і файл фікстур має рівно одного власника; блоки
спілкуються лише через `ctx.actions` (ключі заморожені в 2.1) і стан (типи 2.1).

## 5. Спільні ресурси й ізоляція

- **Тести** не ходять у мережу: `globalThis.fetch` — стаб на тест, `localStorage`/`sessionStorage` — happy-dom
  (чистити в `afterEach`), час — `vi.useFakeTimers()` для кулдауну, автостарту й `delta`.
- **Ручні прогони** з різних worktree: свій `PORT` і `REDIS_URL=redis://localhost:6379/<N>` у
  `.env.local`, свій `DATA_DIR`. Листи — `.data/outbox/*.json` або `GET /api/admin/outbox`.
- **localStorage** `adc.pendingStart` (TTL 24 год; рішення користувача 2026-10-20) і **sessionStorage**
  `adc.return` — ключі заморожені; інші ключі не вводити.
- **Платні API** не чіпаються; `LIVE=1` і `pnpm eval` не запускати.

## 6. План інтеграції

- Інтеграційна гілка `claude/auth-frontend-integration` від `main` після злиття Кроку 0.
- Хвиля 1: **B4 → B1 → B3 → B2**. Хвиля 2: **B7 → B8 → B6 → B5**. Хвиля 3: **B12 → B9 → B10 → B11**.
  Хвиля 4: B13. Після кожного merge решта гілок хвилі оновлюється від інтеграційної.
- Після хвилі 1:
  ```bash
  pnpm typecheck && pnpm lint
  pnpm --filter @adc/api exec vitest run test/project-credits.test.ts test/projects.test.ts test/ui/auth.test.ts test/ui/start.test.ts test/ui/topbar.test.ts test/ui/account-controls.test.ts test/ui/account-core.test.ts
  ```
- Після хвилі 2:
  ```bash
  pnpm typecheck && pnpm lint
  pnpm --filter @adc/api exec vitest run test/ui/cp-brand.test.ts test/ui/cp-board.test.ts test/ui/composer.test.ts test/ui/chat.test.ts test/ui/retry.test.ts test/ui/cabinet.test.ts test/ui/cab-balance.test.ts test/ui/topup.test.ts test/ui/checkout.test.ts test/ui/integration.test.ts
  ```
- Після хвилі 3:
  ```bash
  pnpm typecheck && pnpm lint
  pnpm --filter @adc/api exec vitest run test/ui/session.test.ts test/ui/cab-history.test.ts test/ui/cab-projects.test.ts test/ui/cab-profile.test.ts test/ui/admin.test.ts test/ui/integration.test.ts
  ```
- Хвиля 4 — B13, потім PR у `main` зі статусом у розділі 11.
- Smoke після кожної хвилі: `pnpm --filter @adc/api dev` → `/?fixture=n3-guest`, `/?fixture=n4-menu`,
  `/?fixture=cab-balance`, `/?mock=1` (старий потік «Зерно» не зламаний).

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | команди з 2.11 | Ні |
| Після злиття хвилі | команди хвилі з розділу 6 + smoke | Ні |
| Крок 0 змінив спільний файл (`contracts`, `app`, `view`, `initial`, `data/actions`, `api`) | весь `test/ui` (`pnpm --filter @adc/api exec vitest run test/ui`) | Ні |
| Крок 0 змінив `account.js`, `lib/**`, `shortage.js` | `test/ui/account-core.test.ts` + тести блоків, що їх імпортують (усі `test/ui/*` хвиль, що вже злиті) | Ні |
| **Фінал — усе злито** | `pnpm typecheck && pnpm lint && pnpm test`, потім `pnpm --filter @adc/integration test` | **Так, один раз** |

Правила для агента (дослівно в кожен брифінг):

- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на `main` до змін; якщо падало — не чіпай, лише зафіксуй у звіті.»
- «Фінальний прогін — це ворота перед деплоєм: поки він не зелений, ТЗ не вважається виконаним.»
- «Жодних правок у файлах Кроку 0 з гілки блоку. Потрібна зміна — міні-PR власника Кроку 0.»
- «Візуальні значення — лише з Референсу і `tokens.css`. Не вигадуй відступів, кольорів, радіусів чи розмірів кнопок; нових токенів, окрім чотирьох із 2.8, немає.»
- «DOM — лише через `h()`/`text()`; вставка HTML-рядків заборонена (тексти користувачів і сайтів).»
- «Кожна нова фікстура має ім’я стану з карти Референсу (`#M`) і відкривається через `/?fixture=<ім’я>`; перед здачею блоку порівняй її з кадром на всіх розмірах, указаних у кадрі.»
- «Валюти в інтерфейсі немає (крім `$` для адміна в топбарі та «Усі проєкти»). Плюралізація — лише через `creditWord`/`formatCredits`.»

## 8. Review і Definition of Done

**На блок:** тести блоку зелені; `pnpm lint` чистий на змінених файлах; `pnpm typecheck` зелений;
правки лише у файлах блоку з розділу 4; усі фікстури блоку з карти Референсу є і збігаються з кадрами
(розміри, тексти, стани hover/focus/disabled/busy); клавіатура (Tab, Enter, Esc) і `focus-visible`
працюють; reduced-motion — лише opacity; PR з маленьким diff і скриншотами фікстур поруч із кадрами.

**На Крок 0:** наявні `test/ui/*` зелені з заглушками; `/?mock=1` проходить старий потік; `boot()`
без бекенду (`me` 401/мережа) не падає; `account-core.test.ts` зелений.

**На ТЗ:** фінальний повний прогін зелений (або червоне підтверджено як наявне на `main`); F1–F5
проходять у `accounts-flows.test.ts` і вручну на живому бекенді (розділ 10); Референс у `docs/design/`.

## 9. Запуск у Claude Code

- Крок 0 — одна сесія, окремий PR у `main`.
- Хвилі 1–3 — по чотири сесії Desktop (кожна отримує свій worktree від інтеграційної гілки).
  CLI-еквівалент: `claude -w fe-b1` … `claude -w fe-b4`, потім `fe-b5…b8`, `fe-b9…b12`.
- Хвиля 4 — одна сесія B13.
- Брифінг сесії: посилання на цей файл, ID блоку, рядок карти володіння, команда тестів, правила з
  розділу 7, якір Референсу блоку (`#N1`, `#N4`…), нагадування про `.env.local` (`PORT`, `REDIS_URL`) і
  `pnpm install` у свіжому worktree.
- `main` тримати чистим; після merge — `git worktree remove`.

## 10. Ручний прохід (B13, на живому бекенді)

`pnpm --filter @adc/api dev` + воркер + Redis; `ADMIN_EMAILS=admin@example.com`, `APP_URL` у `.env`.

1. **F1:** гість вводить адресу → «Почати» → реєстрація → посилання з `.data/outbox` у новій вкладці →
   «Активовано · 0» з карткою нестачі → «Поповнити» → «Кілька роликів» → «Оплатити» → автоповернення →
   ролик стартує сам (−10, залишок 15) → топбар показує 15.
2. **F2:** баланс 1 (адмін-коригування), 9:16 + 1:1 → підпис на ЧП1 → «Затвердити й рендерити» →
   відмова в чаті + K3 → «Поповнити» → оплата → «Повернутися до проєкту» → «Повторити» → списано 2.
3. **F3:** після «Готово» підказка «правка — 3 кредити» → правка → «Списано 3 кредитів…» у чаті і
   мітка «−3» у топбарі → нова ревізія.
4. **F4:** «Забули пароль?» → посилання на телефоні (390) → новий пароль → «Вхід виконано»; стара
   сесія в іншому браузері → 401 → форма входу в сцені.
5. **F5:** адмін → користувач → «+5 компенсація» → запис в історії; Outbox → «Копіювати».
6. Чужий `/?project=<id>` → «Проєкт не знайдено»; `/?admin=users` клієнтом → 403; вихід → старт із
   рядком-статусом.

## 11. Статус виконання

Заповнює B13. Інтеграційна гілка — `claude/auth-frontend-integration`; коміт — merge блоку в неї (для Кроку 0 — PR
у `main` і міні-PR). _Чернетка етапу 1 B13: рядки блоків, що ще в роботі, заповнюються після злиття._

| Блок | Коміт | Що зроблено / відхилення |
|---|---|---|
| Крок 0 | PR #45 (правки за ревью `9800e3e`, `5514baa`); міні-PR `1a1bc22` (`AuthState.message`), `6c9b6bc` (`account.prices`) | заморожені інтерфейси §2. Поза ТЗ: `PartDeps.onRoute`, `account.projectCount`, `account.prices`, `AuthState.message`, `adc.pendingStart` у localStorage з TTL 24 год (рішення користувача 2026-10-20) |
| B1 | — | у роботі |
| B2 | `39d6859` | старт для гостя й користувача, відкладений старт, автостарт, flash |
| B3 | `99683c1` | топбар, пілюля балансу, меню акаунта |
| B4 | `91d0c95`, `ec8d93e` | `credits` у рядках проєктів; публічний `GET /api/billing/packages` |
| B5 | — | у роботі |
| B6 | — | у роботі |
| B7 | — | у роботі |
| B8 | — | у роботі |
| B9 | — | у роботі |
| B10 | — | у роботі |
| B11 | — | у роботі |
| B12 | — | у роботі |
| B13 | — | каркас `accounts-flows.test.ts` (стаб бекенду, F1–F5 вимкнені до злиття блоків), README «Інтерфейс акаунтів» |

**Фінальна перевірка (§7 «Фінал»):**

| Перевірка | Результат |
|---|---|
| `pnpm typecheck && pnpm lint && pnpm test` | — |
| `pnpm --filter @adc/integration test` | — |
| F1–F5 у `accounts-flows.test.ts` | — |
| Ручний прохід розділу 10 | — |
