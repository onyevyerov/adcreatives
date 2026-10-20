# ТЗ: авторизація, кабінет і кредитна монетизація — бекенд (макет із заглушками)

Дата: 2026-10-19. Формат — parallel-ready: Крок 0 заморожує схеми акаунтів, леджера, `AccountStore`,
сесії, конфіг кредитів, каркас API і типи оркестратора; далі чотири блоки без спільних файлів, потім
інтеграційний блок (env, Docker, README, статус у цьому ТЗ).

**Обсяг цієї хвилі — лише бекенд**: акаунти, сесії, активація/скидання пароля через e-mail (outbox замість
відправки), ownership проєктів, кредитний леджер, списання в API та оркестраторі, заглушка оплати,
admin-endpoint-и. Фронтенд (екрани входу, кабінет, топбар) — окрема наступна хвиля; тут заморожено лише
контракт API ↔ UI (розділ 10), щоб фронтенд потім робився без змін бекенду.

Передумови: хвиля Epidemic у `main` (PR #41); `pnpm typecheck && pnpm lint && pnpm test` зелені на `main`.

## 1. Мета і контекст

AdCreative сьогодні — демо для команди замовника: один спільний пароль `APP_PASSWORD` (HTTP Basic у
`apps/api/src/auth.ts`), проєкти без власника, гроші — лише внутрішня собівартість у USD
(`costs.jsonl`, `/stats`). У ТЗ v2 авторизація та ізоляція проєктів свідомо винесені в беклог. Тепер сервіс
готують до клієнтів, тож потрібні: акаунти (реєстрація, активація по e-mail, вхід, скидання пароля),
кабінет (баланс у кредитах, поповнення, історія транзакцій, свої проєкти, профіль) і кредитна модель
списання. Реальна математика «гроші ↔ кредити» буде пізніше — усі числа зараз плейсхолдери в
`config/credits.json`.

### 1.1 Рішення власника (2026-10-19)

| Питання | Рішення |
|---|---|
| Глибина макета | Робочий бекенд із заглушками: справжні користувачі, сесії, токени активації/скидання; листи не відправляються — пишуться в `DATA_DIR/outbox` + лог; «оплата» — заглушка з фейковим кроком checkout (успіх/відмова) |
| Кредити | 1 кредит = 1 одиниця реальних грошей (`creditsPerUsd` — плейсхолдер); у UI лише кредити, без валюти |
| Моменти списання | старт проєкту (ціна ролика) + кожна правка після видачі + кожен додатковий формат на ЧП3; правки на чекпоінтах до видачі — безкоштовні; автоповернення, якщо проєкт упав без можливості повтору до першої видачі |
| Вхід | e-mail + пароль з активацією; «Увійти через Google» — заглушка (501) |
| Ролі | `ADMIN_EMAILS` у `.env` → admin: `/stats`, список користувачів, ручне нарахування, dev-outbox листів. Роль не зберігається — обчислюється з e-mail на кожен запит |
| Гості | Лендинг (стартовий екран) відкритий; старт проєкту — лише після входу |

### 1.2 Що додано понад запит (в обсязі бекенду)

- **Список своїх проєктів** (`GET /api/projects` повертає лише свої) — без акаунтів списку для користувача не існувало.
- **Вітальний бонус** (`signupBonus`, плейсхолдер 0) — щоб новий користувач міг спробувати ролик.
- **Адмін-інструменти**: список користувачів із балансами, ручне нарахування/коригування (потрібно для платних перевірок власником), перегляд dev-outbox із посиланнями активації.
- **Безпека**: scrypt-хеші, одноразові хешовані токени з TTL, enumeration-safe відповіді (register/forgot завжди 202), rate-limit на auth, інвалідація всіх сесій при зміні пароля, cookie HttpOnly/SameSite=Lax/Secure за HTTPS, існуючий CSRF-guard лишається.
- **Ідемпотентний леджер**: повтор BullMQ-джоби чи команди не списує двічі.
- **402 з деталями** (`required`, `available`) на старті проєкту, щоб UI міг показати «потрібно N, у вас M».

### 1.3 Анти-цілі (не робимо, іде в беклог — розділ 12)

Справжній OAuth Google, платіжний провайдер і чеки, зміна e-mail, видалення акаунта, промокоди, i18n,
фронтенд.

### 1.4 Ключові архітектурні рішення

- **Персистентність**: користувачі, леджер, поповнення, outbox — файли в `DATA_DIR` (єдина одиниця бекапу,
  той самий патерн, що `costs.jsonl`); сесії й одноразові токени — Redis із TTL (ioredis-mock підтримує
  `set PX NX`, `getdel`, `eval`; `lock.test.ts` уже ганяє Redis-lock на моку).
- **Атомарність**: усі read-check-append леджера — під `lock:user:<id>` (`createRedisLock` у проді,
  `createMemoryLock` у тестах). Lock переїжджає з `packages/pipeline/src/lock.ts` у
  `packages/shared/src/lock.ts` (pipeline — ре-експорт), бо API не залежить від `@adc/pipeline`.
- **Ідемпотентність**: `LedgerEntry.id` = семантичний ключ (`video:<projectId>`, `revision:<projectId>:r<n>`,
  `format:<projectId>:<format>`, `topup:<topupId>`, `bonus:signup:<userId>`, `refund:<projectId>`,
  `adjust:<nanoid>`); повторний `apply` з тим самим ключем — no-op.
- **Списання в оркестраторі — до запису стану**: машина лишається чистою (читає
  `ctx.billing = {prices, balance}` і кладе ефекти `charge`/`refund`), драйвер виконує ці ефекти **перед**
  `enqueueStage`/`writeJson`; `InsufficientCreditsError` → крок відкидається, у чат іде відмова. Інакше
  ревізія стартувала б до фактичного списання.
- **Ownership**: `IntakeFile.ownerId?` і `ProjectState.ownerId?` (`.optional()`, **не** `.nullable().default()`
  — інакше ламаються `fixtureProject()` у `packages/shared/src/fixtures.ts` і літерали `ProjectState` у
  тестах). Проєкти без `ownerId` (eval/test/старі) — без білінгу; бачить лише admin.
  `tests/integration/src/harness.ts` і `eval.ts` пишуть intake без `ownerId` — не зачеплені.
- **Session middleware лише додає `user | null`**; кожен роутер сам ставить `requireUser()`/`requireAdmin()`.
  Публічні: `/`, `/index.html`, `/static/*`, `/healthz`, `/api/auth/*` — бо на них просто немає
  `requireUser`. Жодного allowlist.
- **`basicAuth` лишається опційним staging-gate** (`APP_PASSWORD` задано → як зараз поверх усього);
  `docker-compose.server.yml`: `${APP_PASSWORD:?}` → `${APP_PASSWORD:-}`.
- **Адмін не активується автоматично** (інакше будь-хто міг би зареєструвати адмінський e-mail першим).
  Активація через outbox/лог і є доказом доступу власника.
- **Нових npm-залежностей немає**: `node:crypto` (scrypt, randomBytes, timingSafeEqual), `hono/cookie`,
  zod 4, ioredis. `pnpm-lock.yaml` і кореневий `package.json` не змінюються.
- **Відмови білінгу в чаті** — повідомлення `role: "assistant"` через `t()`; нових типів SSE-подій не
  додаємо (UI оновлюватиме баланс через `GET /api/auth/me`).

## 2. Крок 0 — заморожені інтерфейси (робиться першим, окремим PR у `main`)

Усі зміни схем адитивні: старі `project.json` та `intake.json` без `ownerId` парсяться. Поки Крок 0 не
влитий, паралель не стартує. Власник Кроку 0 далі веде всі міні-PR у `packages/shared/src/accounts/**`,
`apps/api/src/{session,deps,config,app}.ts` і `apps/api/test/helpers.ts`; блоки їх не правлять.

### 2.1 Lock — `packages/shared/src/lock.ts` (новий), `packages/pipeline/src/lock.ts` (ре-експорт)

Перенести `createMemoryLock`, `createRedisLock`, `ProjectLock`, `LockTimeoutError`, `RedisLockOptions` з
`packages/pipeline/src/lock.ts` дослівно; у pipeline лишається `export * from "@adc/shared/lock"`
(subpath уже працює через `"./*": "./src/*.ts"` в `exports` пакета); додатково `export * from "./lock.ts"` у
`packages/shared/src/index.ts`. `packages/pipeline/test/lock.test.ts` працює через ре-експорт без правок;
копія тесту — `packages/shared/test/lock.test.ts`.

### 2.2 Ownership — `packages/shared/src/schemas/project.ts`

```ts
// ProjectState і IntakeFile (адитивно):
/** Власник проєкту (User.id). Відсутнє — проєкт без білінгу: eval, тести, старі проєкти. */
ownerId: z.string().optional(),
```

### 2.3 Схеми акаунтів — `packages/shared/src/accounts/schemas.ts` (новий, zod 4)

```ts
export const UserId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const Email = z.string().trim().toLowerCase().email().max(254);

export const User = z.object({
  id: UserId,
  email: Email,
  name: z.string().trim().min(1).max(80),
  /** "scrypt$N$r$p$<salt b64url>$<hash b64url>" */
  passwordHash: z.string(),
  createdAt: IsoDate,
  activatedAt: IsoDate.nullable(),
});
export const PublicUser = User.omit({ passwordHash: true }).extend({ isAdmin: z.boolean() });

export const LEDGER_KINDS = ["topup", "bonus", "charge", "refund", "adjust"] as const;
export const LedgerKind = z.enum(LEDGER_KINDS);
export const LedgerEntry = z.object({
  /** Ключ ідемпотентності: video:<pid> | revision:<pid>:r<n> | format:<pid>:<format> | topup:<id> | bonus:signup:<uid> | refund:<pid> | adjust:<nanoid> */
  id: z.string().min(1).max(120),
  userId: UserId,
  at: IsoDate,
  kind: LedgerKind,
  /** Цілі кредити; charge < 0, решта > 0 (adjust — будь-який знак ≠ 0). */
  credits: z.number().int(),
  balanceAfter: z.number().int(),
  ref: z.object({
    projectId: z.string().optional(),
    rev: z.number().int().optional(),
    format: Format.optional(),
    topupId: z.string().optional(),
    /** adjust: хто нарахував. */
    byUserId: UserId.optional(),
  }).default({}),
  note: z.string().max(200).default(""),
});

export const TopUpStatus = z.enum(["pending", "paid", "failed"]);
export const TopUp = z.object({
  id: z.string(),
  userId: UserId,
  /** id пакета з credits.json або "custom". */
  packageId: z.string(),
  credits: z.number().int().positive(),
  priceUsd: z.number().min(0),
  status: TopUpStatus,
  createdAt: IsoDate,
  paidAt: IsoDate.nullable(),
});

export const OutboxMail = z.object({
  id: z.string(),
  at: IsoDate,
  to: Email,
  kind: z.enum(["activate", "reset"]),
  subject: z.string(),
  text: z.string(),
  /** Посилання з листа — те, що власник відкриває вручну з outbox/логу. */
  link: z.string().url(),
});

export const CreditPrices = z.object({
  video: z.number().int().min(0),
  revision: z.number().int().min(0),
  extraFormat: z.number().int().min(0),
});
export const CreditsConfig = z.object({
  checkedAt: z.string(),
  currency: z.literal("credits"),
  creditsPerUsd: z.number().positive(),
  prices: CreditPrices,
  packages: z.array(z.object({
    id: z.string(), credits: z.number().int().positive(), priceUsd: z.number().min(0), label: z.string(),
  })).min(1),
  custom: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
  signupBonus: z.number().int().min(0),
});
// + export type для кожної схеми
```

### 2.4 Шляхи — `packages/shared/src/accounts/paths.ts` (новий)

```
users/<id>/user.json                 — User
users/<id>/ledger.jsonl              — LedgerEntry по рядку (append ≤ 4 КБ, як costs.jsonl)
users/<id>/projects.jsonl            — {projectId, createdAt} — індекс для GET /api/projects
users/<id>/topups/<topupId>.json     — TopUp
users-by-email/<sha256(email)>.json  — {userId}   (окрема тека: listDirs("users") інакше поверне індекс як користувача)
outbox/<ts>-<id>.json                — OutboxMail
```

```ts
export const accountPaths = { user(id), ledger(id), projects(id), topup(id, topupId), topupsDir(id), emailIndex(sha), outboxDir: "outbox" };
export const USERS_DIR = "users";
export const userLockKey = (id: string) => `lock:user:${id}`;
export const emailLockKey = (sha: string) => `lock:email:${sha}`;
export const emailHash = (email: string) => sha256(Email.parse(email));
```

### 2.5 Паролі — `packages/shared/src/accounts/password.ts` (новий)

`hashPassword(plain): Promise<string>` / `verifyPassword(plain, stored): Promise<boolean>` на `node:crypto`
scrypt (N=16384, r=8, p=1, salt 16 B, key 64 B; порівняння `timingSafeEqual`; невалідний формат `stored`
→ `false`, не виняток). `PASSWORD_MIN = 8`, `PASSWORD_MAX = 128`. `DUMMY_PASSWORD_HASH` — заздалегідь
згенерований хеш, щоб `login` для неіснуючого e-mail виконував scrypt тієї ж вартості.

### 2.6 `AccountStore` — `packages/shared/src/accounts/store.ts` (новий; патерн `cost/ledger.ts` + lock)

```ts
export class InsufficientCreditsError extends Error {
  override name = "InsufficientCreditsError";
  constructor(public readonly required: number, public readonly available: number) { … }
}
export class EmailTakenError extends Error { override name = "EmailTakenError"; }

export interface LedgerInput { id: string; kind: LedgerKind; credits: number; ref?: LedgerEntry["ref"]; note?: string }

export interface AccountStore {
  createUser(input: { email: string; name: string; password: string }): Promise<User>; // під lock:email; EmailTakenError
  findByEmail(email: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  listUsers(): Promise<User[]>;                                                        // listDirs("users")
  updateUser(id: string, patch: Partial<Pick<User, "name" | "passwordHash" | "activatedAt">>): Promise<User>; // під lock:user
  balance(userId: string): Promise<number>;                                            // сума ledger; биті рядки пропускаються, як readCosts
  readLedger(userId: string, opts?: { limit?: number; before?: string }): Promise<LedgerEntry[]>; // новіші першими; before — id запису
  /**
   * Під lock:user. Дубль id → наявний запис, applied=false (ідемпотентність).
   * credits < 0 при balance + credits < 0 → InsufficientCreditsError(required = -credits, available = balance).
   * Інакше append {…, at, balanceAfter}.
   */
  apply(userId: string, entry: LedgerInput): Promise<{ entry: LedgerEntry; applied: boolean }>;
  addProject(userId: string, projectId: string, createdAt: string): Promise<void>;
  listProjectIds(userId: string): Promise<string[]>;                                   // новіші першими
  createTopUp(t: Omit<TopUp, "status" | "createdAt" | "paidAt">): Promise<TopUp>;      // status pending
  getTopUp(userId: string, id: string): Promise<TopUp | null>;
  listTopUps(userId: string): Promise<TopUp[]>;
  /** Під lock:user: pending → paid|failed рівно один раз; paid → apply({id: `topup:${id}`, kind: "topup"}); повтор — повертає наявний стан. */
  settleTopUp(userId: string, id: string, outcome: "paid" | "failed"): Promise<TopUp>;
}

export function createAccountStore(deps: {
  storage: Storage; lock: ProjectLock; now?: () => Date; idGen?: () => string;
}): AccountStore;
```

### 2.7 Mailer, оплата, сесії, токени, кредити — `packages/shared/src/accounts/{mailer,payment,session,credits}.ts`

```ts
// mailer.ts
export interface Mailer { send(mail: Omit<OutboxMail, "id" | "at">): Promise<OutboxMail> }
/** Пише outbox/<ts>-<id>.json і логує {to, kind, link} рівнем info — це і є «доставка» в макеті. */
export function createOutboxMailer(deps: { storage: Storage; logger?: Logger; now?: () => Date }): Mailer;
export function readOutbox(storage: Storage, limit?: number): Promise<OutboxMail[]>; // новіші першими

// payment.ts
export interface PaymentProvider { createCheckout(topup: TopUp): Promise<{ checkoutUrl: string }> }
/** Заглушка: `${appUrl}/?checkout=<topupId>`; підтвердження — POST /api/billing/topups/:id/confirm. */
export function createStubPayment(appUrl: string): PaymentProvider;

// session.ts (Redis)
export interface SessionStore {
  create(userId: string): Promise<string>;         // token = randomBytes(32).toString("base64url")
  resolve(token: string): Promise<string | null>;  // ковзний TTL (PEXPIRE при зверненні)
  destroy(token: string): Promise<void>;
  destroyAll(userId: string): Promise<void>;       // через set sessions:user:<id>
}
export function createSessionStore(redis: Redis, opts?: { ttlMs?: number /* 30 діб */ }): SessionStore;
// ключ session:<sha256(token)> → userId; у Redis лише хеші токенів

export type TokenKind = "activate" | "reset";
export interface TokenStore {
  issue(kind: TokenKind, userId: string, ttlMs: number): Promise<string>;
  consume(kind: TokenKind, token: string): Promise<string | null>; // GETDEL — одноразовий
}
export function createTokenStore(redis: Redis): TokenStore;        // ключ token:<kind>:<sha256(token)>

// credits.ts (як cost/prices.ts loadPrices — падає голосно)
export function loadCredits(file = path.join(findRepoRoot(), "config/credits.json")): CreditsConfig;
export function defaultCredits(overrides?: Partial<CreditsConfig>): CreditsConfig; // для тестів
```

**Новий `config/credits.json`** (усі значення — плейсхолдери до розрахунку):

```json
{
  "checkedAt": "2026-10-19",
  "currency": "credits",
  "creditsPerUsd": 1,
  "prices": { "video": 10, "revision": 3, "extraFormat": 2 },
  "packages": [
    { "id": "starter", "credits": 10, "priceUsd": 10, "label": "Старт" },
    { "id": "standard", "credits": 25, "priceUsd": 25, "label": "Кілька роликів" },
    { "id": "pro", "credits": 60, "priceUsd": 60, "label": "Серія" }
  ],
  "custom": { "min": 5, "max": 500 },
  "signupBonus": 0
}
```

`packages/shared/src/accounts/index.ts` ре-експортує все; `packages/shared/src/index.ts` → `export * from "./accounts/index.ts"`.

### 2.8 i18n — `packages/shared/src/i18n/uk.ts` (ключі в кінець переліку)

| Ключ | Текст |
|---|---|
| `insufficientCredits` | «Не вистачає кредитів: потрібно {need}, у вас {have}. Поповніть баланс у кабінеті — і я продовжу.» |
| `insufficientCreditsFormats` | «Не вистачає кредитів на додаткові формати: потрібно {need}, у вас {have}. Поповніть баланс або лишіть один формат.» |
| `chargedRevision` | «Списано {credits} кредитів за правку. Залишок: {balance}.» |
| `chargedFormats` | «Списано {credits} кредитів за додаткові формати ({count}). Залишок: {balance}.» |
| `refundedFailure` | «Не вдалося завершити ролик — {credits} кредитів повернуто на баланс.» |

### 2.9 Каркас API — `apps/api/src/{deps,config,session,app,server,index}.ts`, порожні роути

```ts
// deps.ts
export interface ApiDeps {
  storage: Storage; queue: Queue; redis: Redis; config: ApiConfig; logger?: Logger;
  accounts: AccountStore; sessions: SessionStore; tokens: TokenStore; mailer: Mailer; payments: PaymentProvider;
}

// config.ts
export interface ApiConfig {
  …як зараз…
  /** ADMIN_EMAILS: кома, trim, lowercase. Роль обчислюється з e-mail на кожен запит. */
  adminEmails: string[];
  /** APP_URL — база для посилань у листах і checkout; дефолт http://localhost:${PORT}. */
  appUrl: string;
  credits: CreditsConfig;
}
// configFromEnv: ADMIN_EMAILS, APP_URL, loadCredits(); defaultConfig: adminEmails ["admin@example.com"], appUrl "http://localhost:3000", defaultCredits()

// session.ts — повна реалізація в Кроці 0 (мала, і все від неї залежить)
export type AppEnv = { Variables: { user: PublicUser | null } };
export const SESSION_COOKIE = "adc_session";
export function toPublic(user: User, adminEmails: string[]): PublicUser;
export function isAdminEmail(config: ApiConfig, email: string): boolean;
/** getCookie → sessions.resolve → accounts.getUser → c.set("user", …); інакше null. Нічого не блокує. */
export function sessionMiddleware(deps: ApiDeps): MiddlewareHandler<AppEnv>;
/** 401 {error:"unauthorized", message:"Потрібно увійти."} */
export function requireUser(): MiddlewareHandler<AppEnv>;
/** 403 {error:"forbidden", message:"Лише для адміністратора."} (після requireUser) */
export function requireAdmin(): MiddlewareHandler<AppEnv>;
/** HttpOnly; SameSite=Lax; Path=/; Max-Age 30 діб; Secure, якщо x-forwarded-proto: https або URL https. */
export function setSessionCookie(c: Context<AppEnv>, token: string): void;
export function clearSessionCookie(c: Context<AppEnv>): void;
```

`app.ts`: `Hono<AppEnv>`; після `sameOriginGuard` — `app.use("*", sessionMiddleware(deps))`;
`app.route("/api/auth", authRoutes(deps))`, `/api/account`, `/api/billing`, `/api/admin` — файли
`apps/api/src/routes/{auth,account,billing,admin}.ts` у Кроці 0 експортують порожній `new Hono<AppEnv>()`
(власники — B1 і B3). `projectsRoutes`, `statsRoutes`, `filesHandler` переводяться на `Hono<AppEnv>` без
зміни поведінки (B2 додасть перевірки).

`server.ts`: `createAccountStore({storage, lock: createRedisLock(redis)})`, `createSessionStore(redis)`,
`createTokenStore(redis)`, `createOutboxMailer({storage, logger})`, `createStubPayment(config.appUrl)`;
при порожньому `APP_PASSWORD` — попередження «staging-gate вимкнено, доступ лише за сесіями». `index.ts`
експортує нові модулі.

### 2.10 Тестові хелпери — `apps/api/test/helpers.ts`

```ts
export async function setup(
  overrides: Partial<ApiConfig> = {},
  opts: { user?: { email?: string; name?: string; admin?: boolean; credits?: number } | null } = {},
): Promise<Env>;
// Повертає як зараз + { accounts, sessions, tokens, mailer, payments, user: PublicUser | null, cookie: string | null,
//   request(path: string, init?: RequestInit): Promise<Response> }   // request підмішує Cookie: adc_session=…
// opts.user за замовчуванням: { email: "user@example.com", name: "Тест", admin: false } → активований, із сесією.
// opts.user === null → анонім (user null, cookie null, request без Cookie).
export async function seedUser(env: Env, u: { email: string; name?: string; admin?: boolean; activated?: boolean; credits?: number }):
  Promise<{ user: PublicUser; cookie: string; request: Env["request"] }>;
// створює напряму через accounts (+ apply bonus:seed:<uid> на credits) і сесію; admin — лише через adminEmails конфігу
```

`env.app.request` лишається для анонімних перевірок — міграція існуючих тестів у B2 стає механічною.

### 2.11 Типи оркестратора (лише сигнатури; тіла — B4) — `packages/pipeline/src/{machine,driver}.ts`

```ts
// machine.ts
export interface StepContext { …; billing?: { prices: CreditPrices; balance: number } | null }
export type Effect = … 
  | { type: "charge"; key: string; credits: number /* > 0 */; note: string; ref: LedgerEntry["ref"] }
  | { type: "refund"; key: string; credits: number /* > 0 */; note: string; ref: LedgerEntry["ref"] };
export function createInitialProject(input: { …; ownerId?: string }): ProjectState;   // кладе ownerId у стан
// driver.ts
export interface PipelineDriverDeps { …; billing?: { store: AccountStore; prices: CreditPrices } }
```

У Кроці 0 `runEffect` для `charge`/`refund` — no-op, `buildContext` не ставить `billing`; тести pipeline
лишаються зеленими без правок.

### 2.12 Тести Кроку 0

- `packages/shared/test/accounts.test.ts`: дубль e-mail (різний регістр/пробіли) → `EmailTakenError`;
  `findByEmail` нормалізує; ідемпотентний `apply` (другий виклик → `applied: false`, той самий запис, один
  рядок у файлі); `InsufficientCreditsError` з `required/available`; 20 паралельних `apply(-1)` при балансі 10
  під `createMemoryLock` → рівно 10 успішних, баланс 0; `settleTopUp("paid")` двічі → один запис `topup:<id>`;
  `settleTopUp` після `failed` не стає `paid`; `readLedger({limit, before})` пагінує; старий `project.json`
  і `intake.json` без `ownerId` парсяться, `fixtureProject()` компілюється; `createOutboxMailer` пише файл за
  схемою `OutboxMail` і рядок у лог; `loadCredits()` читає `config/credits.json`; `hashPassword`/`verifyPassword`
  (вірний/невірний/зіпсований рядок).
- `packages/shared/test/lock.test.ts` (копія pipeline-тесту).
- `apps/api/test/session.test.ts`: `sessionMiddleware` без cookie → `user null`; з валідною сесією → `PublicUser`
  з `isAdmin` за `adminEmails`; протухла/невідома → null; `requireUser` 401 / `requireAdmin` 403 з тілами;
  `setSessionCookie` ставить `Secure` лише за `x-forwarded-proto: https`; `clearSessionCookie` → `Max-Age=0`.

```bash
pnpm typecheck && pnpm lint
pnpm --filter @adc/shared exec vitest run test/accounts.test.ts test/lock.test.ts test/schemas.test.ts
pnpm --filter @adc/api exec vitest run test/session.test.ts
pnpm --filter @adc/pipeline exec vitest run      # без змін поведінки — має лишитися зеленим
pnpm --filter @adc/api exec vitest run           # існуючі тести API: порожні роути нічого не ламають
```

## 3. Блоки робіт (хвиля 1 — B1–B4 паралельно після Кроку 0; хвиля 2 — B5)

### B1: Auth-маршрути і rate-limit

- **Володіє:** `apps/api/src/routes/auth.ts` (порожній з Кроку 0), новий `apps/api/src/ratelimit.ts`,
  `apps/api/test/auth-routes.test.ts`, `apps/api/test/ratelimit.test.ts`.
- **Залежить від:** Крок 0 (`AccountStore`, `SessionStore`, `TokenStore`, `Mailer`, `session.ts`,
  `helpers.ts`). Нічого з B2–B4.
- **Поведінка:**
  - `createRateLimiter({ max: 10, windowMs: 15 * 60_000, now })` → `{ hit(key: string): boolean }`
    (`true` — ліміт перевищено), ковзне вікно в пам'яті, ключ `${ip}|${email}`; `ip` — перший елемент
    `x-forwarded-for`, інакше `"local"`. Перевищення → `429 {error:"rate_limited", message:"Забагато спроб. Спробуйте за 15 хвилин."}`.
    Один лімітер на `authRoutes(deps)`; у тестах `now` ін'єктується.
  - Усі тіла — zod (`Email`, `name` ≤ 80, пароль `PASSWORD_MIN…MAX`); невалідне → `400 {error:"invalid_body"}`,
    слабкий пароль → `400 {error:"weak_password", message:"Пароль — від 8 до 128 символів."}`.
  - Листи: `activate` → `subject "Активація акаунта AdCreative"`, `link = ${appUrl}/?auth=activate&token=…`;
    `reset` → `subject "Скидання пароля AdCreative"`, `link = ${appUrl}/?auth=reset&token=…`. TTL токенів:
    активація 24 год, скидання 1 год.

| Endpoint | Тіло | Поведінка | Відповідь |
|---|---|---|---|
| `POST /api/auth/register` | `{email, name, password}` | rate-limit; e-mail зайнятий і активований → нічого не шлемо; зайнятий, не активований → перевипуск токена + лист; інакше `createUser` → `tokens.issue("activate")` → `mailer.send` | завжди `202 {message:"Якщо адреса вільна, ми надіслали лист для активації."}`; 400 `weak_password`/`invalid_body`; 429 |
| `POST /api/auth/activate` | `{token}` | `consume("activate")` → `updateUser({activatedAt})` (повторна активація — no-op) → `signupBonus > 0` ? `apply({id: bonus:signup:<uid>, kind:"bonus"})` → `sessions.create` + cookie | `200 {user, balance}` / `400 {error:"invalid_token", message:"Посилання недійсне або застаріло."}` |
| `POST /api/auth/resend` | `{email}` | rate-limit; лише неактивованим — новий токен + лист | завжди 202 |
| `POST /api/auth/login` | `{email, password}` | rate-limit; `findByEmail`; `verifyPassword` виконується **завжди** (на `DUMMY_PASSWORD_HASH`, якщо користувача немає); не активований → `403 not_activated`; ok → сесія + cookie | `200 {user, balance}` / `401 {error:"invalid_credentials", message:"Невірний e-mail або пароль."}` / `403 {error:"not_activated", message:"Акаунт ще не активовано — перевірте пошту."}` |
| `POST /api/auth/logout` | — | `sessions.destroy(token)` (якщо cookie є), clear cookie | 204 |
| `POST /api/auth/forgot` | `{email}` | rate-limit; активованому — `issue("reset")` + лист | завжди `202 {message:"Якщо акаунт існує, ми надіслали лист для скидання пароля."}` |
| `POST /api/auth/reset` | `{token, password}` | `consume("reset")` → `updateUser({passwordHash})` → `sessions.destroyAll(uid)` → нова сесія + cookie | `200 {user, balance}` / 400 `invalid_token` / 400 `weak_password` |
| `GET /api/auth/me` | — | `requireUser` | `200 {user, balance, prices, packages, custom, creditsPerUsd}` / 401 |
| `POST /api/auth/google` | — | заглушка | `501 {error:"not_implemented", message:"Вхід через Google ще не підключено."}` |

- **Критерії приймання:** повний цикл register → токен із `storage.list("outbox")` → activate → `me` →
  logout → `me` 401 → login → `me`; невірний пароль 401, неактивований 403; відповідь на `register`/`forgot`
  для невідомого й відомого e-mail побайтно однакова (статус + тіло), різниця лише в outbox; 11-та спроба
  з одного `ip|email` за 15 хв → 429, після зсуву `now` на 15 хв — знову 202; активаційний токен
  одноразовий (другий `activate` → 400); `reset` робить старий cookie недійсним і видає новий;
  `signupBonus: 5` у конфігу → після активації баланс 5 і запис `bonus:signup:<uid>`; `Secure` у cookie лише
  за `x-forwarded-proto: https`; `google` → 501.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/auth-routes.test.ts test/ratelimit.test.ts`
- **Паралельність:** одночасно з B2, B3, B4.

### B2: Ownership проєктів, scoping файлів, admin-only stats, списання на старті

- **Володіє:** `apps/api/src/routes/projects.ts`, `apps/api/src/routes/files.ts`,
  `apps/api/src/routes/stats.ts`, `apps/api/src/intake.ts` (+ `projectOwner`), тести
  `apps/api/test/{projects,files,stats,auth,sse}.test.ts` (міграція на `env.request`).
- **Залежить від:** Крок 0 (`requireUser`/`requireAdmin`, `AppEnv`, `AccountStore`, `helpers.setup` з
  користувачем, `IntakeFile.ownerId`, `t()`-ключі). Нічого з B1, B3, B4.
- **Поведінка:**
  - `intake.ts`: `projectOwner(storage, id): Promise<string | null>` — читає `ownerId` з `project.json`,
    якщо його немає — з `intake.json`; жодного файлу → `null`. Intake нового проєкту отримує `ownerId: user.id`.
  - `projectsRoutes`: `app.use("*", requireUser())`. `canSee(user, ownerId) = user.isAdmin || (ownerId !== undefined && ownerId !== null && ownerId === user.id)`.
    Middleware на `/:id/*` **і** перевірка в `GET /:id` (він перевіряє існування сам, L209–214) → для чужого
    або неіснуючого — однаковий `404 {error:"not_found"}` (без витоку існування).
  - `POST /`: після валідації форми, **до** `saveUploads`/intake —
    `accounts.apply(user.id, {id: `video:${projectId}`, kind: "charge", credits: -config.credits.prices.video, ref: {projectId}, note: "Відео"})`;
    `InsufficientCreditsError` → `402 {error:"insufficient_credits", message: t("insufficientCredits", {need, have}), required, available}`
    — жодної теки проєкту і жодної джоби. Далі intake з `ownerId`, `accounts.addProject(user.id, projectId, createdAt)`,
    echo, enqueue. Якщо щось після списання впало → best-effort `apply({id: `refund:${projectId}`, kind:"refund", credits: prices.video})`
    і rethrow. Відповідь `201 {id, chatUrl, balance}`. `fail()` розширити на `401 | 402`. Існуючі перевірки
    (`chatUrl`, API не пише `project.json`, SSRF/traversal) лишаються.
  - `GET /`: користувач → `accounts.listProjectIds(user.id)` → рядки як зараз + `ownerId`; admin із `?all=1`
    → `listProjectIds(storage)` (усі, включно без власника). Неіснуючі в індексі id пропускаються.
  - `filesHandler`: анонім → `401` text «Потрібно увійти.»; ключ `projects/<id>/…` →
    `canSee(user, await projectOwner(storage, id))`, інакше 404 text; будь-який інший ключ (`cache/…`,
    `costs*.jsonl`) — лише admin, інакше 404. Усі перевірки traversal лишаються до перевірки доступу.
  - `statsRoutes`: `requireUser()` + `requireAdmin()` на `/api/stats`, `/api/stats.csv`; `/stats` (HTML)
    → анонім 401 text, не-admin `403` HTML «Лише для адміністратора».
- **Критерії приймання:** чужий проєкт → 404 на `GET /:id`, `/:id/events`, `/:id/messages`, `/:id/commands`,
  `/:id/uploads`, `GET /files/projects/<id>/…`; свій — 200 як раніше; анонім → 401 на всьому
  `/api/projects/*`; 402 при балансі < `prices.video` не створює теку `projects/<id>` і джобу, тіло містить
  `required`/`available`; успішний `POST` → intake має `ownerId`, леджер `video:<id>` з правильним
  `balanceAfter`, `projects.jsonl` має рядок; другий `POST` (інший проєкт) списує ще раз; `GET /`
  користувача не показує чужі й безхазяйні; admin з `?all=1` бачить усе; `/stats`, `/api/stats` для
  не-admin → 403, для admin → 200; `files` для `cache/…` — лише admin.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/projects.test.ts test/files.test.ts test/stats.test.ts test/auth.test.ts test/sse.test.ts`
- **Паралельність:** одночасно з B1, B3, B4.

### B3: Кабінет, поповнення (заглушка оплати), admin

- **Володіє:** `apps/api/src/routes/account.ts`, `apps/api/src/routes/billing.ts`,
  `apps/api/src/routes/admin.ts` (усі порожні з Кроку 0), тести `apps/api/test/{account,billing,admin}.test.ts`.
- **Залежить від:** Крок 0 (`AccountStore`, `PaymentProvider`, `readOutbox`, `session.ts`, `helpers`).
  Нічого з B1, B2, B4.
- **Поведінка:**
  - `account.ts` (`requireUser`): `GET /api/account` → `{user, balance}`; `PATCH /api/account {name}` → `{user}`
    (400 `invalid_body`); `POST /api/account/password {current, next}` → `verifyPassword(current)` інакше
    `401 invalid_credentials` → `updateUser({passwordHash})` → `sessions.destroyAll` → нова сесія + cookie →
    `{ok: true}`; `GET /api/account/transactions?limit=50&before=<entryId>` → `{entries, nextBefore}`
    (`limit` 1…200, дефолт 50; `nextBefore` = id останнього в сторінці, якщо сторінка повна, інакше `null`).
  - `billing.ts` (`requireUser`): `GET /api/billing/packages` → `{creditsPerUsd, prices, packages, custom}`;
    `POST /api/billing/topups` з `{packageId}` **або** `{credits}` (custom: ціле в межах `custom.min…max`,
    `priceUsd = credits / creditsPerUsd`, `packageId: "custom"`; невідомий пакет або поза межами → 400
    `invalid_body`) → `createTopUp` → `payments.createCheckout(topup)` → `201 {topup, checkoutUrl}`;
    `GET /api/billing/topups` → `{topups}` (свої, новіші першими); `GET /api/billing/topups/:id` → `{topup}`
    (чужий/неіснуючий → 404); `POST /api/billing/topups/:id/confirm {outcome: "paid" | "failed"}` → лише
    власник → `settleTopUp` → `200 {topup, balance}`; повторний confirm повертає той самий стан без
    другого запису (`failed` після `paid` або навпаки — теж no-op, стан не змінюється).
  - `admin.ts` (`requireUser` + `requireAdmin`): `GET /api/admin/users` →
    `{users: [{…PublicUser, balance}]}` (сортування за `createdAt`); `GET /api/admin/users/:id` → `{user, balance}`;
    `POST /api/admin/users/:id/credits {credits: int ≠ 0, note ≤ 200}` →
    `apply({id: `adjust:${nanoid}`, kind: "adjust", credits, ref: {byUserId: admin.id}, note})` → `{entry, balance}`;
    від'ємне коригування нижче нуля → `402 insufficient_credits`; `GET /api/admin/users/:id/transactions?limit&before`
    → як у кабінеті; `GET /api/admin/outbox?limit=50` → `{mails}` (новіші першими — тут власник бере посилання активації).
- **Критерії приймання:** зміна пароля інвалідує інші сесії (другий cookie → 401), а поточний запит
  отримує новий cookie; старий пароль після зміни → 401; `transactions` пагінуються `before` без дублів і
  пропусків на 120 записах; `topups` з пакетом і custom; custom поза межами і нецілий → 400; `confirm`
  чужого → 404; `confirm paid` двічі → один `topup:<id>` у леджері, баланс +credits один раз;
  `confirm failed` → баланс без змін, статус `failed`; admin `credits` додає/віднімає, від'ємне нижче
  нуля → 402; не-admin на `/api/admin/*` → 403, анонім → 401; `outbox` повертає листи з `link`.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/account.test.ts test/billing.test.ts test/admin.test.ts`
- **Паралельність:** одночасно з B1, B2, B4.

### B4: Білінг в оркестраторі — правки після видачі, додаткові формати, повернення

- **Володіє:** `packages/pipeline/src/machine.ts`, `packages/pipeline/src/driver.ts` (тіла; типи з Кроку 0),
  `packages/pipeline/test/{machine,driver,helpers}.ts`, новий `packages/pipeline/test/billing.test.ts`,
  `apps/worker/src/main.ts`.
- **Залежить від:** Крок 0 (`StepContext.billing`, `Effect charge/refund`, `PipelineDriverDeps.billing`,
  `AccountStore`, `createInitialProject({ownerId})`, i18n-ключі). Нічого з B1–B3.
- **Поведінка — машина** (чиста, читає лише `ctx.billing`; без `ctx.billing` поведінка як сьогодні):
  - `startRevision` (`machine.ts` L622): якщо `d.project.phase === "revision"` (тобто перша видача вже була)
    і є `billing` → `need = prices.revision`; `balance < need` → `d.say(t("insufficientCredits", {need, have: balance}))`
    і return **без** `newRevision` (статус лишається `delivered`); інакше
    `effects.push({type: "charge", key: `revision:${id}:r${n}`, credits: need, note: "Правка", ref: {projectId, rev: n}})`
    (`n` — номер нової ревізії) + `d.say(t("chargedRevision", {credits: need, balance: balance - need}))`.
    Правки на чекпоінтах до першої видачі (`at: "script" | "storyboard"`) — безкоштовні, ефектів немає.
  - `approveStoryboard` (L398): якщо `phase === "first_delivery"`, є `billing` і `formats.length > 1` →
    `need = (formats.length − 1) × prices.extraFormat`; `balance < need` → `say(t("insufficientCreditsFormats", {need, have}))`,
    лишаємось у `awaiting_storyboard`; інакше по одному `charge` на кожен додатковий формат
    (`key: format:<id>:<format>`, `credits: prices.extraFormat`, `ref: {projectId, format}`) +
    `say(t("chargedFormats", …))`. Ключ списується раз на проєкт — повторне затвердження з тими самими
    форматами в пізнішій ревізії дає `applied: false` у драйвері, без другого списання.
  - `onStageFailed` (L675): `!ev.error.retryable && ev.stage !== "crawl" && d.project.firstDeliveredAt === null && billing`
    → `effects.push({type: "refund", key: `refund:${id}`, credits: prices.video, note: "Повернення за збій", ref: {projectId}})`
    + `d.say(t("refundedFailure", {credits: prices.video}))`. `crawl` виключено — у нього власне відновлення
    через `manualText` (L479–490). Ключ один на проєкт: другий збій після restart не повертає вдруге.
- **Поведінка — драйвер:**
  - `buildContext` (`driver.ts` L263): `state.project.ownerId && deps.billing` →
    `ctx.billing = {prices: deps.billing.prices, balance: await deps.billing.store.balance(ownerId)}`, інакше `null`.
  - `step()` (L353): після `nextStep`, **перед** `enqueueStage`/`writeJson`/іншими ефектами — для кожного
    ефекту `charge`/`refund` по порядку: `billing.store.apply(ownerId, {id: key, kind: "charge" | "refund", credits: ±credits, ref, note})`.
    `InsufficientCreditsError` (гонка: баланс змінився між `buildContext` і `apply`) →
    `emitAll(id, [{type: "message", role: "assistant", text: t("insufficientCredits", {need, have})}])` і
    `return state` — стан не записано, джоби не поставлені, подія/команда вважається обробленою.
    `runEffect` для `charge`/`refund` — no-op (уже виконано).
  - `initFromStart` (L410): `createInitialProject({…, ownerId: intake.ownerId})`.
- **Worker** `apps/worker/src/main.ts`: `billing: {store: createAccountStore({storage, lock: createRedisLock(redis)}), prices: loadCredits().prices}`.
- **Тести:** `Harness` у `test/helpers.ts` отримує опційний `billing?: {credits: number}` — `AccountStore` на
  `createMemoryLock()` і тому ж `LocalStorage`, seed користувача `u_test0001` з `bonus:seed`, `ownerId` в
  intake/`create()`. Кейси `billing.test.ts`: правка після видачі списує `revision:p1:r2` рівно раз навіть
  при повторній доставці тієї ж команди (ідемпотентність на redelivery); баланс < `revision` → ревізії
  немає, статус `delivered`, у стрімі `insufficientCredits`; баланс рівно `revision` → списано до 0;
  ЧП3 з `["vertical", "square"]` при `first_delivery` списує `format:p1:square` один раз, повторне
  затвердження в ревізії 2 — не списує; ЧП3 з одним форматом — нічого; non-retryable `codegen` до видачі →
  `refund:p1` один раз і повідомлення; retryable — ні; `crawl` — ні; збій після `firstDeliveredAt` — ні;
  проєкт без `ownerId` → жодного виклику `store.apply` (шпигун), існуючі `machine.test.ts`/`driver.test.ts`
  зелені без зміни очікувань.
- **Критерії приймання:** усі кейси вище; `project.json` не записується, якщо `apply` кинув
  `InsufficientCreditsError`; порядок у `step()`: списання → запис стану → enqueue.
- **Команда:** `pnpm --filter @adc/pipeline exec vitest run test/billing.test.ts test/machine.test.ts test/driver.test.ts`
- **Паралельність:** одночасно з B1, B2, B3.

### B5: Інтеграція — env, Docker, README, статус ТЗ (хвиля 2, після злиття B1–B4)

- **Володіє:** `.env.example`, `docker-compose.server.yml`, `README.md`, розділ 13 цього файлу.
- **Залежить від:** усі B1–B4 в інтеграційній гілці.
- **Поведінка:**
  - `.env.example`: `ADMIN_EMAILS=` («e-mail адміністраторів через кому; роль обчислюється на кожен запит»),
    `APP_URL=http://localhost:3000` («база для посилань у листах і checkout»); коментар до `APP_PASSWORD`:
    «опційний staging-gate поверх акаунтів; порожній — лише сесії».
  - `docker-compose.server.yml`: `${APP_PASSWORD:?…}` → `${APP_PASSWORD:-}`; прокинути `ADMIN_EMAILS`, `APP_URL`;
    коментар у шапці оновити.
  - README: розділ «Користувачі, кредити, адмін» (реєстрація → посилання активації в
    `docker compose logs api` або `.data/outbox/*.json`, або `GET /api/admin/outbox`; `config/credits.json` —
    плейсхолдери до розрахунку; admin-endpoint-и і ручне нарахування; оплата — заглушка `/?checkout=<id>` +
    `confirm`; Google — заглушка; `ADMIN_EMAILS`, `APP_URL`); оновити «Запуск у Docker» і «Деплой»
    (пароль не обов'язковий); таблицю env; ручний прохід із розділу 11 як чеклист.
  - Розділ 13 цього ТЗ: статус, коміти, свідомі відхилення.
- **Критерії приймання:** `docker compose -f docker-compose.server.yml config` проходить без `APP_PASSWORD`;
  README описує шлях «зареєструватись → активувати → поповнити → запустити ролик» без UI (curl).
- **Тести:** лише smoke-команди розділу 6 для хвилі 1 (README/env тестів не мають).
- **Паралельність:** послідовно, після злиття хвилі 1.

## 4. Карта володіння файлами

| Блок | Файли |
|---|---|
| Крок 0 | `packages/shared/src/{lock.ts,index.ts}`, `packages/shared/src/schemas/project.ts`, `packages/shared/src/i18n/uk.ts`, `packages/shared/src/accounts/**` (нові), `packages/shared/test/{accounts,lock}.test.ts` (+ правка `schemas.test.ts`), `packages/pipeline/src/lock.ts` (ре-експорт), типи в `packages/pipeline/src/{machine,driver}.ts`, `config/credits.json`, `apps/api/src/{app,deps,config,session,server,index}.ts`, порожні `apps/api/src/routes/{auth,account,billing,admin}.ts`, `apps/api/test/{helpers.ts,session.test.ts}` |
| B1 | `apps/api/src/routes/auth.ts`, `apps/api/src/ratelimit.ts`, `apps/api/test/{auth-routes,ratelimit}.test.ts` |
| B2 | `apps/api/src/routes/{projects,files,stats}.ts`, `apps/api/src/intake.ts`, `apps/api/test/{projects,files,stats,auth,sse}.test.ts` |
| B3 | `apps/api/src/routes/{account,billing,admin}.ts`, `apps/api/test/{account,billing,admin}.test.ts` |
| B4 | `packages/pipeline/src/{machine,driver}.ts` (тіла), `packages/pipeline/test/**`, `apps/worker/src/main.ts` |
| B5 | `.env.example`, `docker-compose.server.yml`, `README.md`, розділ 13 цього ТЗ |

Спільні файли — один власник: `packages/shared/**` → Крок 0 (після нього — лише міні-PR власника Кроку 0;
якщо блоку потрібна зміна в `accounts/**` або `uk.ts` — він просить власника Кроку 0, а не править сам);
`apps/api/src/{app,deps,config,session,server,index}.ts`, `apps/api/test/helpers.ts` → Крок 0, у хвилі 1
**ніхто не править** (B1–B3 лише імпортують); `apps/api/src/auth.ts` (`basicAuth`, `sameOriginGuard`),
`apps/api/src/uploads.ts`, `routes/{events,static}.ts` → не чіпати; `packages/pipeline/src/{machine,driver}.ts`
→ типи в Кроці 0, тіла — B4 (єдиний власник у хвилі 1); `tests/integration/**`, `scripts/**` → не чіпати
(intake без `ownerId` → без білінгу); `package.json`/`pnpm-lock.yaml` → нових залежностей немає;
`README.md`, `.env.example`, `docker-compose.server.yml` → лише B5.

Перевірка перетинів: B1, B2, B3 — різні файли в `apps/api/src/routes` і різні тестові файли; усі три
монтуються в `app.ts`, який заморожено в Кроці 0 (порожні роутери), тож `app.ts` у хвилі 1 не змінюється.
B2 і B4 обидва читають `ownerId`, але з різних файлів (`intake.ts` у API, `driver.ts` у pipeline).
B4 — єдиний, хто торкається pipeline; B2 — єдиний, хто мігрує існуючі API-тести на `env.request`.

## 5. Спільні ресурси й ізоляція

- **Redis** — єдиний спільний стан поза git, і worktree його не ізолює: сесії, токени, lock. У тестах —
  `ioredis-mock` з `flushall()` у `setup()` (мок ділить дані між інстансами в одному процесі — тому
  `flushall` обов'язковий і вже є в `helpers.ts`). Для ручних запусків — свій номер БД на worktree у
  `.env.local`: `REDIS_URL=redis://localhost:6379/1`, `/2`, … .
- **Сховище** — `DATA_DIR` у кожного worktree своє (`.data`); у тестах `mkdtemp`. Користувачі/леджер/outbox
  живуть там само — бекап і очищення як у решти артефактів.
- **Порти** — ручні прогони API з різних worktree: свій `PORT` у `.env.local`.
- **Листи й платежі** — реальних немає: `createOutboxMailer` пише файли, `createStubPayment` повертає
  локальний URL. Жоден блок не додає SMTP/платіжний SDK.
- **Платні API** (Anthropic, ElevenLabs, Epidemic) — у хвилі не чіпаються; тести pipeline працюють на
  моках як сьогодні. `LIVE=1` і `pnpm eval` у блоках не запускати.
- **Секрети** — `ADMIN_EMAILS` і `APP_URL` у `.env` (не комітяться); у тестах `defaultConfig` дає
  `admin@example.com`.

## 6. План інтеграції

- Інтеграційна гілка: `claude/auth-monetization-integration` від `main` після злиття Кроку 0.
- Порядок злиття хвилі 1: **B1 → B2 → B3 → B4** (спершу вхід, потім ownership і списання в API, потім
  кабінет/admin, потім оркестратор). Після кожного merge решта гілок оновлюється від інтеграційної
  (`sync_with_base_branch`), щоб конфлікти спливали малими порціями.
- Після хвилі 1 (в інтеграційній гілці):
  ```bash
  pnpm typecheck
  pnpm lint
  pnpm --filter @adc/shared exec vitest run test/accounts.test.ts test/lock.test.ts test/schemas.test.ts
  pnpm --filter @adc/api exec vitest run
  pnpm --filter @adc/pipeline exec vitest run test/billing.test.ts test/machine.test.ts test/driver.test.ts
  ```
  (`@adc/api` — весь пакет, бо B1–B3 разом покривають усі його тести, а B2 мігрує старі.)
- Хвиля 2 — B5 в інтеграційній гілці, потім PR у `main` зі статусом у розділі 13.
- Після злиття в `main` — власник проходить ручний сценарій розділу 11 через curl. Тести його не замінять.

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | `pnpm typecheck && pnpm lint` + команди з 2.12 | Ні |
| Після злиття хвилі 1 | команди з розділу 6 | Ні |
| Блок змінив спільний файл (лише Крок 0 має право) | `accounts/**` → `shared/test/accounts.test.ts` + `api/test/session.test.ts`; `schemas/project.ts` → `shared/test/schemas.test.ts`, `pipeline/test/machine.test.ts`, `integration/test/pipeline.test.ts`; `uk.ts` → `pipeline/test/machine.test.ts`; `apps/api/src/{app,session,deps,config}.ts` або `test/helpers.ts` → весь `@adc/api`; `pipeline/src/{machine,driver}.ts` → `pipeline/test/*` + на інтеграції `integration/test/{pipeline,eval}.test.ts` | Ні |
| **Фінал — усе злито** | `pnpm typecheck && pnpm lint && pnpm test`, потім `pnpm --filter @adc/integration test` (≈2 хв, потрібні браузери) | **Так, один раз** |

Правила для агента (дослівно в кожен брифінг):

- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на `main` до
  змін; якщо падало — не чіпай, лише зафіксуй у звіті.» Відомі червоні на Windows на `main`:
  `director/test/check-strip.test.ts`, `integration/test/eval-run.test.ts` (`--from render`).
- «Фінальний прогін — це ворота: поки він не зелений (або червоне підтверджено як наявне на `main`), ТЗ не
  вважається виконаним.»
- «Жодних правок у `packages/shared/**`, `apps/api/src/{app,deps,config,session,server,index}.ts`,
  `apps/api/test/helpers.ts` з блоків хвилі 1. Потрібна зміна — міні-PR власника Кроку 0.»
- «Жодних нових npm-залежностей. Паролі — лише `node:crypto` scrypt; токени — `randomBytes`; у Redis і на
  диску зберігаються лише хеші.»
- «Тести не роблять реальних мережевих викликів і не читають `.env`: конфіг — `defaultConfig`, Redis —
  `ioredis-mock`, сховище — `mkdtemp`.»
- «`ownerId` — `.optional()`. Якщо `fixtureProject()` або літерали `ProjectState` у тестах почервоніли на
  typecheck — це баг блоку, а не привід робити поле обов'язковим.»

## 8. Review і Definition of Done

**На блок:** тести блоку зелені; `pnpm lint` чистий на змінених файлах; `pnpm typecheck` зелений; жодних
правок поза файлами з карти володіння (розділ 4); PR в інтеграційну гілку з маленьким diff і описом
«що входить / перевірки / що лишилось».

**На Крок 0:** схеми адитивні (старі `project.json`/`intake.json` парсяться), `fixtureProject()` компілюється
без правок, порожні роутери змонтовані, `session.ts` покритий тестом, `pnpm --filter @adc/pipeline exec vitest run`
і `pnpm --filter @adc/api exec vitest run` зелені без зміни очікувань, `config/credits.json` читається.

**На ТЗ:** фінальний повний прогін зелений (або червоне збігається зі списком у розділі 7);
`pnpm --filter @adc/integration test` зелений (eval/integration без `ownerId` → без білінгу); README,
`.env.example`, compose оновлені; власник пройшов ручний сценарій розділу 11 і записав у розділ 13 статус,
коміти, відхилення.

## 9. Запуск у Claude Code

- Крок 0 — одна сесія, окремий PR у `main`. Поки не влито, блоки не стартують.
- Хвиля 1 — чотири сесії Desktop (кожна отримує свій worktree від інтеграційної гілки): B1, B2, B3, B4 —
  усі одночасно (стеля 4). CLI-еквівалент: `claude -w auth-b1` … `claude -w auth-b4`.
- Хвиля 2 — одна сесія B5 в інтеграційній гілці.
- Брифінг кожної сесії: посилання на цей файл, ID блоку, карта володіння (розділ 4), команда тестів,
  правила з розділу 7, нагадування про `.env.local` (`REDIS_URL` з окремим номером БД, `PORT`) і
  `pnpm install` у свіжому worktree.
- `main` тримати чистим; після merge — `git worktree remove`.

## 10. Контракт API ↔ UI (заморожено; фронтенд наступної хвилі робиться проти нього)

- `user`: `{id, email, name, isAdmin, activatedAt}`; усі гроші — цілі кредити, без валюти.
- `GET /api/auth/me` → `{user, balance, prices: {video, revision, extraFormat}, packages: [{id, credits, priceUsd, label}], custom: {min, max}, creditsPerUsd}` | 401.
- Помилки — JSON `{error, message, …}`:

| Статус | `error` | Коли |
|---|---|---|
| 400 | `invalid_body` | zod не пройшов |
| 400 | `weak_password` | пароль поза 8…128 |
| 400 | `invalid_token` | токен активації/скидання невідомий або протух |
| 401 | `unauthorized` | немає сесії |
| 401 | `invalid_credentials` | невірний e-mail/пароль; невірний `current` при зміні пароля |
| 402 | `insufficient_credits` + `{required, available}` | старт проєкту; admin-коригування нижче нуля |
| 403 | `forbidden` | не admin |
| 403 | `not_activated` | вхід до активації |
| 404 | `not_found` | немає або чужий проєкт/топап (без витоку існування) |
| 429 | `rate_limited` | auth-ліміт 10 за 15 хв |
| 501 | `not_implemented` | Google |

- Поповнення: `TopUp.status ∈ pending | paid | failed`; `POST /api/billing/topups` → `201 {topup, checkoutUrl}`;
  `POST /api/billing/topups/:id/confirm {outcome: "paid" | "failed"}` → `{topup, balance}` (ідемпотентно).
- Історія: `GET /api/account/transactions?limit&before` → `{entries: LedgerEntry[], nextBefore: string | null}`
  (новіші першими).
- Проєкти: `POST /api/projects` → `201 {id, chatUrl, balance}` | 402; `GET /api/projects` → лише свої
  (admin `?all=1` — усі), рядок містить `ownerId`.
- Витрати по проєкту (фронтенд-ТЗ B4): рядок `GET /api/projects` і `GET /api/projects/:id` містять
  `credits: {charged, refunded, parts: [{kind: "video" | "revision" | "format" | "refund", credits, format?, rev?}]} | null`
  — записи леджера власника з `ref.projectId`; `charged` — сума модулів charge, `refunded` — сума refund,
  `parts` від старіших до новіших, `credits` зі знаком леджера (charge < 0, refund > 0); без `ownerId` → `null`.
- Посилання з листів: `${APP_URL}/?auth=activate&token=…`, `${APP_URL}/?auth=reset&token=…`;
  checkout-заглушка: `${APP_URL}/?checkout=<topupId>` — UI показує фейковий крок «Оплатити / Скасувати» і
  викликає `confirm`.
- Cookie `adc_session`: HttpOnly, SameSite=Lax, Path=/, Max-Age 30 діб, Secure за
  `x-forwarded-proto: https`. CSRF — існуючий `sameOriginGuard` (UI робить запити з того ж origin).
- Відмови/списання білінгу під час роботи над роликом приходять у стрім проєкту як звичайні повідомлення
  `assistant`; UI після них оновлює баланс через `GET /api/auth/me`. Нових SSE-подій немає.

## 11. Ручний прохід (власник, після злиття в `main`)

`pnpm --filter @adc/api dev` + воркер + Redis, `ADMIN_EMAILS` і `APP_URL` у `.env`; через curl/HTTP-клієнт,
бо UI ще немає.

1. `POST /api/auth/register` → файл у `.data/outbox/` (або лог API) з `link` → `POST /api/auth/activate {token}`
   → cookie → `GET /api/auth/me` (баланс 0 або `signupBonus`).
2. `POST /api/billing/topups {packageId: "starter"}` → `POST …/confirm {outcome: "paid"}` → баланс 10;
   `GET /api/account/transactions` показує `topup`.
3. `POST /api/projects` (multipart як у UI) → 201 з `balance: 0`, у `users/<id>/ledger.jsonl` — `video:<id>`;
   другий `POST /api/projects` → 402 з `required: 10, available: 0`.
4. Після видачі — правка через `POST /api/projects/:id/messages`: у стрімі «Списано 3 кредитів…» або
   відмова при балансі < 3; ЧП3 з двома форматами списує додатковий формат.
5. `/stats` і `/api/admin/*` — 403 для звичайного користувача, 200 для `ADMIN_EMAILS`;
   `POST /api/admin/users/:id/credits` змінює баланс; чужий `GET /api/projects/<id>` → 404;
   `GET /files/projects/<id>/…` чужого → 404.
6. `APP_PASSWORD` задано → Basic-gate поверх усього, як раніше; порожній — лише сесії.

## 12. Свідомі прогалини макета і беклог

**Свідомі прогалини (прийнято, у коді не виправляємо в цій хвилі):**

- Баланс у `ctx.billing` оптимістичний (знятий у `buildContext`); авторитетне списання — `apply` у драйвері,
  тому машина може сказати «списано», а драйвер — відкинути крок через гонку. Користувач побачить лише
  відмову (повідомлення машини не записується, бо стан відкинуто).
- Додаткові формати при повторному затвердженні ЧП3 рахуються всі, але ключі `format:<id>:<format>`
  списують один раз на проєкт; повідомлення `chargedFormats` може назвати суму, більшу за фактично списану.
- Restart після `refund` безкоштовний — друге повернення не станеться (ключ `refund:<id>` один), а друге
  списання `video:<id>` теж не станеться (той самий ключ). Виправляється admin-`adjust`, якщо треба.
- У `Storage` немає `remove` — сироти (невдалі реєстрації, протухлі outbox-листи, `pending`-топапи) не чистяться.
- Rate-limit у пам'яті процесу — скидається з рестартом і не ділиться між репліками.
- `listUsers()` читає всі `user.json` — для сотень користувачів прийнятно, для тисяч потрібен індекс.
- Токени активації/скидання живуть лише в Redis — втрата Redis означає «надішліть лист ще раз».

**Беклог (окремі хвилі):**

- Фронтенд: екрани входу/реєстрації/активації/скидання, кабінет (баланс, поповнення з фейковим checkout,
  історія, свої проєкти, профіль), топбар із балансом, обробка 401/402 у чаті.
- Справжній OAuth Google; платіжний провайдер (webhook замість `confirm`), чеки/інвойси.
- Реальна тарифікація: `creditsPerUsd`, ціни, пакети, `signupBonus` за даними `costs.jsonl`.
- Зміна e-mail, видалення акаунта, промокоди, i18n листів і повідомлень.
- SMTP/транзакційна пошта замість outbox; `Storage.remove` і прибирання сиріт.
- Персистентний/розподілений rate-limit; аудит дій admin.

## 13. Статус виконання

Заповнює B5 після злиття хвилі 1: гілки/коміти по блоках, що зроблено, свідомі відхилення від тексту ТЗ,
результат ручного проходу розділу 11.

| Блок | Коміт | Що зроблено |
|---|---|---|
| Крок 0 | `da7eca7` (PR #42) | lock у `@adc/shared` (pipeline — ре-експорт); `ownerId?` у `ProjectState`/`IntakeFile`; `accounts/**`: схеми, шляхи, scrypt, `AccountStore` з ідемпотентним леджером під `lock:user`, outbox-mailer, заглушка оплати, сесії й токени в Redis, `loadCredits`; `config/credits.json`; i18n; каркас API (`ApiDeps`/`ApiConfig`, `session.ts`, порожні роутери); типи оркестратора; тести shared/session |
| B1 | `029135b` (PR #43) | `/api/auth/*`: register/activate/resend/login/logout/forgot/reset/me, Google 501; ковзний rate-limit 10/15 хв за `ip\|email`; enumeration-safe 202; dummy-scrypt для неіснуючого e-mail; токени 24 год / 1 год |
| B2 | `b894533` (PR #43) | ownership (`ownerId` в intake, однаковий 404 для чужого/неіснуючого), scoping `/files/*`, `/stats` і `/api/stats*` — лише admin, списання `video:<id>` до створення проєкту (402 з `required/available`), best-effort refund при збої старту, `GET /api/projects` — свої (admin `?all=1`); старі API-тести мігровано на сесії |
| B3 | `dbdb58e` (PR #43) | кабінет (профіль, зміна пароля з інвалідацією сесій, транзакції з пагінацією), поповнення (пакети/custom, заглушка checkout, ідемпотентний `confirm`), admin (користувачі, коригування, транзакції, outbox) |
| B4 | `aa795bd` (PR #43) | машина: `revision:<id>:r<n>` після першої видачі, `format:<id>:<f>` на ЧП3, `refund:<id>` при non-retryable збої до першої видачі (крім `crawl`); драйвер виконує charge/refund до enqueue і запису стану, `InsufficientCreditsError` → відмова в чат і крок відкидається; worker отримує `billing` |
| Інтеграція хвилі 1 | `1f1b905` (PR #43) | `session.test.ts`: `auth/me` з cookie замість 404 порожнього роутера Кроку 0 |
| B5 | цей PR | `.env.example` (`ADMIN_EMAILS`, `APP_URL`, `APP_PASSWORD` — опційний gate); `docker-compose.server.yml` (`APP_PASSWORD` опційний, прокинуті `ADMIN_EMAILS`, `APP_URL` з дефолтом `https://${APP_DOMAIN}`); README — розділ «Користувачі, кредити, адмін» (env, curl-шлях, чеклист розділу 11), оновлені «Запуск у Docker» і «Деплой» |

**Свідомі відхилення від тексту ТЗ:**

- B1: власний текст 202 для `resend`; `weak_password` у `reset` перевіряється до споживання токена (слабкий пароль не «спалює» посилання).
- B2: при ціні відео 0 пишеться charge на 0 кредитів (слід у леджері); `/api/projects/:id/trace` теж під перевіркою власника.
- B3: `nextBefore` ≠ null лише коли далі справді є записи; власний текст 402 для admin-коригування нижче нуля.
- B4: оптимістичний баланс у `ctx.billing` повертає вже оплачені ключі поточного кроку (повтор після збою запису не відмовляє); при відмові правки вибрані формати відкочуються; нульова ціна — без ефекту.
- B5: `APP_URL` у `docker-compose.server.yml` за замовчуванням `https://${APP_DOMAIN}` (у ТЗ — лише «прокинути»), щоб посилання в листах на сервері не вели на `localhost`. Окремої env-таблиці в README не було — додано таблицю трьох нових/змінених змінних у розділі «Користувачі, кредити, адмін».

- B5: `tests/integration/test/infra.test.ts` (поза картою володіння B5) перевіряв стару вимогу
  `${APP_PASSWORD:?…}` — оновлено під опційний пароль, `ADMIN_EMAILS` і `APP_URL`; інакше критерій приймання B5
  суперечив би тесту.

**Перевірки (B5, macOS):** `docker compose -f docker-compose.yml -f docker-compose.server.yml config` з порожнім
`APP_PASSWORD` проходить; `pnpm typecheck`, `pnpm lint` — чисті; smoke розділу 6: shared 51 ✓, api 559 ✓,
pipeline billing/machine/driver 128 ✓. Фінальний `pnpm test` — усі unit-пакети зелені; `@adc/integration` —
68 ✓ / 1 ✗: `eval-run.test.ts` «`--from render` перезапускає рендер…» падає так само й на `0c9126d` (до хвилі
auth) — наявна червона зі списку розділу 7 (там позначена для Windows, відтворюється і на macOS), не чіпали.

**Ручний прохід розділу 11** — ще не виконано; робить власник після злиття в `main` (чеклист — у README,
«Користувачі, кредити, адмін») і дописує сюди результат.
