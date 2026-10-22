# Використання: контракт API ↔ UI (`/api/admin/usage`)

Вкладка адмінки `/?admin=usage`: скільки коштують клієнти, проєкти, моделі й етапи за період. Джерело —
рядки `CostEvent` у `projects/<id>/costs.jsonl` і `costs-shared.jsonl`; кредити — `ledger.jsonl` користувачів.
TS-дзеркало — `apps/api/src/usage/types.ts`, JSDoc-дзеркало — `apps/api/public/static/js/contracts.js`.

- Власник проєкту береться при читанні: `ownerId` з `project.json`, інакше з `intake.json`.
- Бази немає: повний скан `projects/*`, знімок у пам'яті з TTL 15 с — **дані можуть відставати до 15 с**.
- `usd` — як записано в події, без перерахунку (ціни вже зафіксовані в `unitPrices`).
- Маржа — оцінка «чи покривають списання собівартість», а не каса: бонусні кредити теж списуються.

Усі ендпоінти — під `requireUser()` + `requireAdmin()` (гість → 401 `unauthorized`, не адмін → 403
`forbidden`), лише `GET`.

## Спільні параметри

| Параметр | Значення | Помилка |
|---|---|---|
| `from` | `YYYY-MM-DD`, включно з 00:00:00Z цього дня (`ts >= from`) | нерозбірне → 400 `invalid_query` |
| `to` | `YYYY-MM-DD`, включно з усім днем (`ts < to + 1 день`) | нерозбірне → 400 `invalid_query`; `to < from` → 400 `invalid_range`, `message: "Дата «До» раніша за «Від»."` |
| `source` | `chat` (дефолт) \| `eval` \| `test` \| `all` — фільтр по `CostEvent.source` | інше → 400 `invalid_query` |

Дати — дні UTC (`ts` записано в UTC). Відсутні `from`/`to` — межі не накладаються. Тіло помилки —
`ApiError {error, message}`. Числа ніколи не `null`, крім полів, де `null` прямо дозволено нижче; порожня
агрегація → `0` / `[]`. Гроші — USD, округлення до 6 знаків (`Math.round(x * 1e6) / 1e6`).

## Спільні форми

```ts
type UsageTokens = { input: number; output: number; cacheWrite: number; cacheRead: number; total: number };
// cacheWrite = units.cacheWrite + units.cacheWrite1h; total = сума чотирьох

type UsageAggregate = {
  calls: number;          // кількість рядків CostEvent
  tokens: UsageTokens;    // лише з TokenUnits (Anthropic)
  audioSeconds: number;   // SecondsUnits (ElevenLabs, Epidemic)
  renders: number;        // RendersUnits (Remotion)
  usd: number;
};
type UsageModelRow = UsageAggregate & { provider: Provider; model: string };
// сортування: usd ↓, provider ↑, model ↑
type UsageStageRow = { stage: CostStage; calls: number; usd: number };
// сортування: usd ↓, stage ↑
```

## `GET /api/admin/usage/summary?from&to&source`

```jsonc
{
  "from": "2026-10-01", "to": null, "source": "chat",          // ехо запиту
  "totals": {
    /* UsageAggregate по ВСІХ подіях вікна, включно з «Системою» */
    "users": 12,              // різні власники з ≥1 подією у вікні
    "projects": 40,           // проєкти з ≥1 подією у вікні
    "delivered": 31,          // проєкти з firstDeliveredAt у вікні (без вікна — усі з firstDeliveredAt ≠ null)
    "avgUsdPerDelivered": 2.41,   // Σ usd УСІХ подій phase=first_delivery цих `delivered` проєктів (не обрізаних вікном) / delivered; null, якщо delivered = 0
    "avgUsdPerRevision": 0.62,    // Σ usd подій phase=revision у вікні / кількість різних (projectId, rev) серед них; null, якщо 0
    "creditsCharged": 310,        // Σ(−credits) charge − Σ credits refund з ledger.jsonl усіх користувачів, `at` у вікні; null, якщо source ∉ {chat, all}
    "creditsUsd": 310.0,          // creditsCharged / creditsPerUsd; null — як вище
    "marginUsd": 214.5            // creditsUsd − usd подій проєктів З власником у вікні; null — як вище
  },
  "byModel": [ /* UsageModelRow[] по всіх подіях вікна */ ],
  "byStage": [ /* UsageStageRow[] по всіх подіях вікна */ ],
  "system": { /* UsageAggregate: проєкти без ownerId + costs-shared.jsonl */ }
}
```

## `GET /api/admin/usage/users?from&to&source&sort&order`

```jsonc
{
  "from": null, "to": null, "source": "chat",
  "users": [
    {
      /* UsageAggregate користувача у вікні */
      "id": "u_8xk2…", "email": "olena@example.com", "name": "Олена", "createdAt": "2026-10-02T…",
      "projects": 3, "delivered": 2,               // визначення — як у summary, лише проєкти цього власника
      "creditsCharged": 26, "marginUsd": 19.1,      // null, якщо source ∉ {chat, all}
      "byModel": [ /* UsageModelRow[] цього користувача */ ]
    }
  ]
}
```

| Правило | Поведінка |
|---|---|
| Склад | **Усі** користувачі з `accounts.listUsers()`; без подій у вікні — рядок із нулями (таблиця не «стрибає») |
| `sort` | `usd` (дефолт) \| `email` \| `projects` \| `createdAt` \| `marginUsd`; інше → 400 `invalid_query` |
| `order` | `desc` (дефолт) \| `asc`; тайбрейкер — `email ↑` |
| `marginUsd = null` при сортуванні по ньому | у кінці незалежно від `order` |
| «Система» | **не** входить у `users`; її сума — `summary.system` |

## `GET /api/admin/usage/projects?owner&from&to&source&search&sort&order&page&pageSize`

```jsonc
{
  "owner": null,                 // ехо: null | "none" | "<userId>"
  "from": null, "to": null, "source": "chat",
  "page": 1, "pageSize": 25,
  "total": 40,                   // проєктів у вибірці (усі сторінки)
  "items": [
    {
      /* UsageAggregate проєкту у вікні */
      "projectId": "p_…",
      "ownerId": "u_8xk2…", "ownerEmail": "olena@example.com",   // null для проєктів без власника
      "host": "zerno.example.com",    // хост input.url; для manual — null
      "url": "https://zerno.example.com/",   // null для manual
      "status": "delivered",          // ProjectStatus; "intake", якщо є лише intake.json; null — мета не читається
      "createdAt": "2026-10-03T…",    // null — мета не читається
      "firstDeliveredAt": "2026-10-03T…",   // або null
      "revisions": 2,                 // різні rev з phase=revision у вікні
      "firstDeliveryUsd": 2.2, "revisionUsd": 1.1,   // у вікні
      "byModel": [ /* UsageModelRow[] */ ],
      "byStage": [ /* UsageStageRow[] */ ]
    }
  ],
  "totals": { /* UsageAggregate по ВСІЙ вибірці (усі сторінки) */ }
}
```

| Правило | Поведінка |
|---|---|
| `owner` | відсутній — усі проєкти; `none` — проєкти без `ownerId`; інакше id користувача (`UserId` — ≥ 8 символів, з `none` не перетинається). Невідомий id → **404** `not_found`, `message: "Користувача не знайдено."` |
| Склад вибірки | проєкти з ≥1 подією у вікні після фільтра `source`. `costs-shared.jsonl` сюди **не** входить (це не проєкт) |
| `search` | без урахування регістру по `host`, `url`, `projectId`, а без `owner` — ще й `ownerEmail`. Порожній — не фільтрує |
| `sort` | `usd` (дефолт) \| `createdAt` \| `tokens` (`tokens.total`) \| `calls` \| `host` \| `status` \| `ownerEmail`; інше → 400 `invalid_query` |
| `order` | `desc` (дефолт) \| `asc`; тайбрейкер — `createdAt ↓`, далі `projectId ↑`; `null` у ключі сортування — у кінці |
| `pageSize` | дефолт 25, максимум 200; більше або < 1 → 400 `invalid_query` |
| `page` | з 1; за межами вибірки → `items: []`, `total` правильний |

Проєкт, мету якого (`project.json` / `intake.json`) не вдалося прочитати, лишається у вибірці: гроші
рахуються, `ownerId`, `host`, `url`, `status`, `createdAt`, `firstDeliveredAt` — `null`.

## `GET /api/admin/usage/projects.csv?owner&from&to&source&search`

Та сама вибірка без пагінації, сортування `usd ↓` (тайбрейкери — як у `projects`).

| Правило | Поведінка |
|---|---|
| Кодування | UTF-8 **з BOM**, `Content-Type: text/csv; charset=utf-8` |
| Ім'я | `Content-Disposition: attachment; filename="adcreative-usage-{YYYY-MM-DD}.csv"` (дата запиту, UTC) |
| Колонки | `owner_email,project_id,host,status,created_at,first_delivered_at,calls,tokens_input,tokens_output,tokens_cache_write,tokens_cache_read,audio_seconds,renders,usd,first_delivery_usd,revision_usd` |
| Формат | кома; десятковий — крапка; дати ISO; `null` — порожнє поле; поля з комою/лапками/переводом рядка — в лапках, лапки подвоюються |
| Формули | у `owner_email`, `host`, `status` значення, що починається з `=` `+` `-` `@`, табуляції чи `\r`, отримує префікс `'` (Excel не виконає його як формулу); числа не змінюються |
| Останній рядок | без `owner` і без `search` — `costs-shared.jsonl` у вікні (навіть нульовий): `project_id` порожній, `host` = `(спільні витрати)`. З `search` або `owner` його немає — експорт сходиться з таблицею `projects` |
| Помилки | як у `projects` (400 / 404) — JSON, не CSV |
