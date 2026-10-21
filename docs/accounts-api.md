# Акаунти й кредити: контракт API ↔ UI, прогалини, беклог

Контракт, проти якого зроблено фронтенд акаунтів (`apps/api/public/static/js/data/account-api.js`) і стаб
бекенду в `apps/api/test/ui/accounts-flows.test.ts`. Перенесено з ТЗ бекенду (§10, §12) і статусу ТЗ фронтенду
після завершення обох хвиль.

## Контракт API ↔ UI

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

- Пакети: `GET /api/billing/packages` → `{creditsPerUsd, prices, packages, custom}` — публічний (без сесії,
  лише під командним Basic-гейтом), щоб гість на старті бачив ціну; решта `/api/billing/*` — 401 без сесії.
- Поповнення: `TopUp.status ∈ pending | paid | failed`; `POST /api/billing/topups` → `201 {topup, checkoutUrl}`;
  `POST /api/billing/topups/:id/confirm {outcome: "paid" | "failed"}` → `{topup, balance}` (ідемпотентно).
- Історія: `GET /api/account/transactions?limit&before` → `{entries: LedgerEntry[], nextBefore: string | null}`
  (новіші першими).
- Проєкти: `POST /api/projects` → `201 {id, chatUrl, balance}` | 402; `GET /api/projects` → лише свої
  (admin `?all=1` — усі), рядок містить `ownerId`.
- Витрати по проєкту: рядок `GET /api/projects` і `GET /api/projects/:id` містять
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

## Свідомі прогалини

**Бекенд:**

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

**Фронтенд:**

- `.cd-head` на 1024 дає зсув 3 px.
- ЧП1 показує обрані формати лише до надсилання «Формати: …»: після нього тайли знову беруться з `payload.formats`
  чекпоінта, а бекенд ЧП1 не перевидає. Рядок «спишу на ЧП3» видно, поки вибір не надіслано; ЧП3 рахує суму
  правильно — з розкадровки.

## Беклог

- Справжній OAuth Google; платіжний провайдер (webhook замість `confirm`), чеки/інвойси.
- Реальна тарифікація: `creditsPerUsd`, ціни, пакети, `signupBonus` за даними `costs.jsonl`.
- Зміна e-mail, видалення акаунта, промокоди, i18n листів і повідомлень.
- SMTP/транзакційна пошта замість outbox; `Storage.remove` і прибирання сиріт.
- Персистентний/розподілений rate-limit; аудит дій admin.
