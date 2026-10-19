# AdCreative

Демо-сервіс: URL сайту бізнесу (+ фото) → бренд-кіт → сценарій → код сцен (Remotion) → музика й SFX →
рекламні motion-відео 15–30 с у форматах 9:16 / 1:1 / 16:9. Діалог у web-чаті з трьома чекпоінтами.

Специфікація: [docs/superpowers/specs/2026-10-06-adcreative-design.md](docs/superpowers/specs/2026-10-06-adcreative-design.md),
повне ТЗ з блоками робіт: [docs/superpowers/specs/adcreative-tz-v2.md](docs/superpowers/specs/adcreative-tz-v2.md),
якість звуку (LUFS, моно-сумісність, такт, тональність): [docs/superpowers/specs/2026-10-13-audio-quality-tz.md](docs/superpowers/specs/2026-10-13-audio-quality-tz.md),
звукорежисер і рецензент фільму: [docs/superpowers/specs/2026-10-15-sound-designer-film-review-tz.md](docs/superpowers/specs/2026-10-15-sound-designer-film-review-tz.md),
акаунти, кабінет і кредити (бекенд): [docs/superpowers/specs/2026-10-19-auth-monetization-tz.md](docs/superpowers/specs/2026-10-19-auth-monetization-tz.md).

## Вимоги

- Node.js ≥ 22.12 (прод — Node 22 у Docker)
- pnpm 10 через corepack: `corepack enable` (або `corepack pnpm …` без глобального ввімкнення)
- Docker Desktop — для Redis (на Windows) і повного запуску
- Ключі Anthropic і ElevenLabs — лише для живих прогонів і реальної роботи

## Швидкий старт (розробка)

```bash
corepack enable
pnpm install
cp .env.example .env        # вписати ключі і свій e-mail в ADMIN_EMAILS; APP_PASSWORD — порожній
docker run -d --name adc-redis -p 6379:6379 redis:7 redis-server --appendonly yes
```

`DATA_DIR` (дефолт `.data`) рахується від кореня репозиторію, тож кожен worktree має своє сховище.
Для паралельних worktree — свій `REDIS_URL` (`redis://localhost:6379/1`, `/2`, …) і `PORT` у `.env.local`.

## Команди

| Команда | Що робить |
|---|---|
| `pnpm --filter @adc/<пакет> test` | тести одного пакета (основний режим під час роботи над блоком) |
| `pnpm typecheck` | `tsc --noEmit` у всіх пакетах, де він оголошений |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm test` | усі тести — лише на фінальному кроці |
| `pnpm smoke` | 2-с ролик із `TemplateScene` (B3) |
| `pnpm eval` | прогін пайплайна по `eval/sites.json` (B9) |
| `pnpm sfx-cache` | генерація стандартних SFX (B5) |
| `pnpm audio-measure -- <файл> \| --project <id> [--rev n] \| --sfx-cache` | замір звуку: LUFS, dBTP, RMS, crest, кореляція L/R, смуги, RMS по секундах; таблиця семплів кешу SFX (`--data-dir` — інше сховище) |
| `LIVE=1 pnpm --filter @adc/shared live` | живий прогін Кроку 0: схеми як structured output, стрім xhigh, запис витрат |

Живі прогони (`LIVE=1`) ходять у платні API і пишуть витрати з `source: "test"`.

## Структура

```
packages/
  shared/      заморожені інтерфейси: схеми, таймлайн, сховище, LLM-обгортка, облік витрат, події, черги
  crawler/     B1    brandkit/   B2    motion-kit/  B3    render/  B3
  director/    B4    audio/      B5    pipeline/    B7
apps/
  api/         B6 (Hono + чат-сторінка + /stats)
  worker/      B8 (BullMQ)
  remotion/    B3 (хост-композиції Main і ScenePreview)
tests/integration/   B9
prompts/       промпти LLM (frontmatter: model, effort, max_tokens, cache)
config/prices.json   ціни для обліку витрат
eval/sites.json      сайти для eval (заповнює замовник)
```

### `@adc/shared` — як імпортувати

Пакет без збірки: експортує TypeScript-джерела (tsx, vitest і rspack їх розуміють).

```ts
import { BrandKit, Storyboard, computeTimeline, createLlm } from "@adc/shared";
import { projectPaths } from "@adc/shared/storage";
import { fixtureBrandKit } from "@adc/shared/fixtures";   // канонічні фікстури для тестів
import { createMockAnthropic } from "@adc/shared/llm";     // мок Anthropic для unit-тестів
```

Зміни в `packages/shared` після Кроку 0 — лише окремим міні-PR власника Кроку 0.

### Промпти

`prompts/<name>.md`: frontmatter + тіло; рядок `=== user ===` відділяє системну частину (кешується)
від користувацької. Змінні — `{{var}}` (об'єкти підставляються як JSON). Хеш файлу пишеться в журнал
витрат і трейс. У dev файл перечитується на кожен виклик.

Кеш і довідка (подробиці — коментар у `packages/shared/src/llm/prompts.ts`):

- `prefix: motion-reference` — спільна довідка (`kind: prefix`) іде першим системним блоком зі своїм
  breakpoint-ом; codegen і code-fix ділять один запис кешу;
- `cache_ttl: 5m | 1h` — TTL системного блоку; довші TTL мають іти перед коротшими;
- рядок `=== cache ===` у user-частині — текст до нього кешується окремим блоком (5 хв);
- `schema_mode: prompt` — JSON Schema одразу в промпті (великі схеми, як BrandKit).

### Перемикачі генерації (`ADC_*`)

`readTuning()` з `@adc/shared` читає їх на старті воркера; невалідне значення — помилка старту.
Дефолти — погоджена конфігурація (`ADC_CODEGEN_MODE=film`: один автор — весь фільм за один виклик; effort `high`, `ADC_QA_MAX_ROUNDS=2`).
Відкат до послідовної генерації без деплою коду:
`ADC_CODEGEN_MODE=sequential ADC_CODEGEN_ANCHOR_EFFORT=xhigh ADC_CODEGEN_REST_EFFORT=high`.
Повний список — `TUNING_ENV` у `packages/shared/src/tuning.ts`.

**Агентний режим генерації** (`ADC_GENERATION_MODE=agent`, дефолт `pipeline`). Замість codegen сцени пише
стадія `author` (`packages/author`, промпт `prompts/author.md`): один агент пише кожну сцену інструментом
(`write_scene`: AST-guard + типи + журнал версій), сам рендерить і дивиться стрічки (`render_strip`,
`render_frames`, `contact_sheet`), читає звукові події (`audio_events`) і завершує (`finish`). Далі — той самий
`check` ↔ `fix`, а QA — страховка: не більше одного кола (`ADC_QA_MAX_ROUNDS` може лише зменшити). Правки після
стілів і видачі в цьому режимі теж ідуть через `author` (лише зачеплені сцени). Бюджет стадії:

| Змінна | Дефолт | Що обмежує |
|---|---|---|
| `ADC_AUTHOR_TOKEN_BUDGET` | 3 000 000 (мін. 500 000) | сумарні токени: input + output + запис і читання кешу |
| `ADC_AUTHOR_MAX_ITERATIONS` | 40 (5–80) | відповіді моделі з викликами інструментів |
| `ADC_AUTHOR_MAX_MINUTES` | 25 (5–60) | час стадії |

Після будь-якого ліміту сцени без робочого коду лагодить звичайний `fix`. Вартість — оцінка $15–30 на ролик
проти ≈ $4 у `pipeline` (оцінка за токенами чат-сесії, не замір; фактичні $ і хвилини — етап L,
`costs.jsonl` з `detail: author:iter:<n>` і `author:strip:<scene>`, журнал викликів —
`rev/<n>/director/author/log.jsonl`, підсумок — `rev/<n>/director/author/report.json`). Режим читається на кожен
крок оркестратора і діє з наступного старту режисури; воркер черги `llm` у цьому режимі рендерить кадри, тож
йому потрібен браузер Remotion.

### Звукорежисер і рецензент фільму

Звук подій ставиться по готовій картинці, а не наосліп у розкадровці; перед ЧП3 весь ролик дивиться рецензент.

```
storyboard → ЧП2 → codegen|author → check ↔ fix → qa ↔ fix → sfx ─┐
                 └→ audio{music} ─────────────────────────────────┴→ audio{mix} → review ─┬→ ЧП3 → render
                                                                                          │
                                  fix(review) → check → sfx(instructions) → audio{mix} ←──┘ (≤ N кіл)
```

- **`sfx`** (`prompts/sfx-design.md`, Opus `medium`) — дивиться стрічки й аркуші моментів (кадри ±2 навколо
  подій і склейок, їх кладе `check` у `check.moments`) у головному форматі і для кожної події розкадровки
  вирішує cue/акцент або мовчання → `rev/<n>/sfx-plan.json`. Нових кадрів не вигадує; ліміти ударів
  тримає код (один ретрай, далі обрізання від кінця ролика). Звук із розкадровки — чернетка.
- **`audio`** ділиться на фази: `music` (план, трек, прогрів усіх 30 cue — паралельно з кодом) і `mix`
  (зведення з накладеним планом SFX, пише звукову відомість `rev/<n>/sound-sheet.json`: кадр, зсув до долі,
  пік кожної події, старти сцен проти тактів, RMS по секундах). `pnpm audio-measure -- --project <id>` друкує
  відомість таблицями.
- **`review`** (`prompts/review.md`, Opus `high`) — стрічки всіх сцен, аркуші моментів, аркуші інших форматів
  і відомість текстом → `rev/<n>/review.json`. Вердикт і маршрути ставить код: візуальні зауваження → `fix`
  (`reason: "review"`), звукові → `sfx`, музичні — лише попередження на ЧП3. Без відомості звук не судиться.
- ЧП3 показує оцінку рецензента і до 10 зауважень major/critical із маршрутом. Збої `sfx` і `review` ревізію
  не зупиняють: звук лишається з розкадровки, рецензія пропускається з повідомленням у чат.

| Змінна | Дефолт | Що робить |
|---|---|---|
| `ADC_SFX_MODE` | `designer` | `storyboard` — звук із розкадровки, стадії `sfx` немає, `audio` однією фазою `full` (як до ТЗ) |
| `ADC_FILM_REVIEW` | `on` | `off` — без рецензента, після зведення одразу ЧП3 (у режимі `storyboard` рецензії немає завжди) |
| `ADC_REVIEW_MAX_ROUNDS` | `1` (0–2) | скільки кіл правок за рецензією; `0` — лише оцінка на ЧП3 |

Відкат без деплою: `ADC_SFX_MODE=storyboard ADC_FILM_REVIEW=off`. Режим фіксується на старті ревізії.
Бюджет (оцінка за токенами, не замір): `sfx` ≈ $0.5–1 на ролик, `review` ≈ $1.5–3 на коло — разом +$2–4 і
+3–6 хв на ролик при одному колі. Фактичні цифри — `costs.jsonl` зі `stage: sfx | review`.

### Провайдер музики і SFX (тест Epidemic Sound)

Прототип для порівняння на слух ([ТЗ](docs/superpowers/specs/2026-10-19-epidemic-sound-test-tz.md)). Epidemic
не генерує: стадія `audio` шукає готовий трек чи семпл у каталозі, підганяє трек під тривалість
(`tracks/versions`, бета) і завантажує. Перевірки ті самі (`checkTrack`, `sfxQc`), мікшер не змінюється.

| Змінна | Дефолт | Що робить |
|---|---|---|
| `ADC_MUSIC_PROVIDER` | `elevenlabs` | `epidemic` — трек із каталогу Epidemic Sound (пошук за брифом + темп, вибір LLM) |
| `ADC_SFX_PROVIDER` | `elevenlabs` | `epidemic` — семпли з каталогу; завантажуються лише варіанти, що реально звучать |
| `EPIDEMIC_API_KEY` | — | ключ Partner API (`epidemic_live_…`); потрібен, лише якщо будь-який провайдер `epidemic` |
| `ADC_EPIDEMIC_DIR` | `<корінь checkout>/.data/epidemic` | лічильник завантажень `downloads.json` і постійний кеш треків/семплів |

Провайдери фіксуються на старті ревізії (як `ADC_SFX_MODE`). **Квота:** безкоштовний тариф — 50 завантажень
(без комерційної ліцензії, ролики нікуди не публікуються). Локальний лічильник рахує `version`,
`version_fetch`, `track`, `sfx` і зупиняє прогін на 45 (`epidemic_quota`, без повторів). Лічильник живе в
`ADC_EPIDEMIC_DIR`, а не в `DATA_DIR`: на час тесту задайте абсолютний шлях у кореневому `.env`, щоб усі
прогони з будь-якого checkout ділили один лічильник і кеш. Без ключа й без нових env усе — як раніше.
Перевірка зв'язку без завантажень: `LIVE=1 pnpm --filter @adc/audio live:epidemic`. Як прогнати тест —
[eval/README.md](eval/README.md#тест-epidemic-sound).

## Користувачі, кредити, адмін

Макет монетизації (ТЗ [2026-10-19-auth-monetization-tz.md](docs/superpowers/specs/2026-10-19-auth-monetization-tz.md)):
справжні акаунти й сесії, а листи, оплата і Google — заглушки. Екранів входу й кабінету в UI ще немає, тож
поки що все робиться через API (curl). Контракт API ↔ UI описаний у розділі 10 ТЗ.

| Змінна | Дефолт | Що робить |
|---|---|---|
| `ADMIN_EMAILS` | — | e-mail адміністраторів через кому. Роль не зберігається, а обчислюється з e-mail на кожен запит |
| `APP_URL` | `http://localhost:${PORT}` (на сервері — `https://${APP_DOMAIN}`) | база для посилань у листах і checkout |
| `APP_PASSWORD` | — | опційний staging-gate: HTTP Basic поверх усього, разом із сесіями. Якщо порожній, діють лише сесії |

- **Акаунти** — e-mail + пароль (8–128 символів, scrypt). Вхід можливий лише після активації. Сесія живе в cookie `adc_session`
  (HttpOnly, SameSite=Lax, 30 діб, Secure за HTTPS); зміна або скидання пароля завершує всі сесії. Лендинг відкритий
  для всіх, а старт проєкту — лише після входу. На `/api/auth/*` діє ліміт: 10 спроб за 15 хв.
- **Листи** не відправляються. Кожен лист пишеться в `DATA_DIR/outbox/<час>-<id>.json` і в лог API
  (`лист в outbox` з полем `link`), а адміну він доступний через `GET /api/admin/outbox`. Посилання мають вигляд
  `${APP_URL}/?auth=activate&token=…` і `${APP_URL}/?auth=reset&token=…`. Токен із посилання передають у
  `POST /api/auth/activate` або `POST /api/auth/reset`. Адмінський e-mail теж активується листом, а не автоматично.
- **Кредити** — цілі числа, без валюти. Ціни, пакети, `creditsPerUsd` і `signupBonus` лежать у `config/credits.json`;
  це **плейсхолдери** до реального розрахунку тарифів. Без валідного файлу API не стартує. Що списується: старт
  проєкту (`video`, якщо кредитів не вистачає — 402 з `required`/`available`), кожна правка після видачі (`revision`)
  і кожен додатковий формат на ЧП3 (`extraFormat`). Правки на чекпоінтах до видачі безкоштовні. Якщо проєкт упав
  до першої видачі без можливості повтору, ціна ролика повертається автоматично. Відмови й списання приходять у чат
  звичайними повідомленнями. Леджер ідемпотентний: `DATA_DIR/users/<id>/ledger.jsonl`.
- **Оплата — заглушка.** `POST /api/billing/topups` повертає `checkoutUrl` = `${APP_URL}/?checkout=<topupId>`,
  а «оплата» — це `POST /api/billing/topups/<id>/confirm {"outcome":"paid"|"failed"}` (ідемпотентно).
- **Google** — `POST /api/auth/google` → 501.
- **Адмін** (`ADMIN_EMAILS`): `/stats` і `/api/stats*`, `GET /api/admin/users[/:id[/transactions]]`,
  ручне нарахування або коригування `POST /api/admin/users/<id>/credits {"credits": 20, "note": "…"}` (знак будь-який,
  але баланс не може стати від'ємним — інакше 402), dev-outbox `GET /api/admin/outbox`, а також усі проєкти
  (`GET /api/projects?all=1`). Звичайний користувач отримує тут 403. Чужий проєкт і його файли — 404.
- Проєкти без `ownerId` (eval, CLI, інтеграційні тести, старі) білінгу не мають, і бачить їх лише адмін.

Шлях «зареєструватись → активувати → поповнити → запустити ролик» через curl (API на `localhost:3000`,
cookie — у `jar.txt`; якщо задано `APP_PASSWORD`, до кожного виклику додайте `-u x:$APP_PASSWORD`):

```bash
API=http://localhost:3000; J='content-type: application/json'
curl -s -X POST $API/api/auth/register -H "$J" -d '{"email":"me@example.com","name":"Я","password":"secret-pass-1"}'   # 202
ls .data/outbox/   # або: docker compose logs api | grep 'лист в outbox'  → link …?auth=activate&token=<TOKEN>
curl -s -c jar.txt -X POST $API/api/auth/activate -H "$J" -d '{"token":"<TOKEN>"}'   # ставить cookie
curl -s -b jar.txt $API/api/auth/me                                                   # user, balance, prices, packages
curl -s -b jar.txt -X POST $API/api/billing/topups -H "$J" -d '{"packageId":"starter"}'   # 201 {topup, checkoutUrl}
curl -s -b jar.txt -X POST $API/api/billing/topups/<topupId>/confirm -H "$J" -d '{"outcome":"paid"}'   # balance 10
curl -s -b jar.txt $API/api/account/transactions
curl -s -b jar.txt -X POST $API/api/projects -H "$J" -d '{"url":"https://example.com"}'   # 201 {id, chatUrl, balance}
```

Далі ролик можна вести через `POST /api/projects/<id>/messages {"text":…}` і `/commands {"type":"approve"}`
або у веб-чаті. Чат-сторінка поки не вміє входити сама. Щоб відкрити `/?project=<id>` у браузері, увійдіть з
консолі DevTools на тому ж origin:
`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})})`.
Повторний вхід з curl — `POST /api/auth/login`, вихід — `/api/auth/logout`, скидання — `/api/auth/forgot` → лист →
`/api/auth/reset {"token","password"}`. Профіль і пароль: `PATCH /api/account {"name"}`,
`POST /api/account/password {"current","next"}`.

### Ручний прохід (чеклист, розділ 11 ТЗ)

API + воркер + Redis, у `.env` задані `ADMIN_EMAILS` і `APP_URL`:

- [ ] `register` → лист в `.data/outbox/` (або в лозі) → `activate` → cookie → `me` (баланс 0 або `signupBonus`).
- [ ] `topups {"packageId":"starter"}` → `confirm {"outcome":"paid"}` → баланс 10; у `transactions` є `topup`.
- [ ] `POST /api/projects` → 201 з `balance: 0`, у `users/<id>/ledger.jsonl` з'явився `video:<id>`; другий старт → 402 з `required: 10, available: 0`.
- [ ] Після видачі правка через `messages`: у стрімі «Списано 3 кредитів…» або відмова при балансі < 3; ЧП3 з двома форматами списує додатковий формат.
- [ ] `/stats` і `/api/admin/*` віддають 403 звичайному користувачу і 200 адміну; `POST /api/admin/users/<id>/credits` змінює баланс; чужий `GET /api/projects/<id>` і `/files/projects/<id>/…` → 404.
- [ ] Із заданим `APP_PASSWORD` Basic-gate працює поверх усього, як раніше; з порожнім діють лише сесії.

## Відхилення від тексту ТЗ (технічні, свідомі)

- **`jobId`**: `<projectId>.<stage>.r<rev>.a<attempt>` замість `<projectId>:<stage>:<rev>:<attempt>` —
  BullMQ 6 відхиляє власні ID з `:`.
- **Трейс** — `trace.jsonl` (рядок на виконання стадії) замість `trace.json`: кілька воркерів пишуть
  паралельно; зведений вигляд віддає `readTrace()`.
- **Vitest** — `vitest.config.ts` з `test.projects` замість `vitest.workspace.ts` (workspace-файл
  прибрано у Vitest 4+).
- **TypeScript 6.0** (не 7): B4 потрібен JS compiler API для `typecheckScenes`.
- **Structured output**: власне перетворення Zod → strict JSON Schema (`toStrictJsonSchema`), бо хелпер
  SDK `zodOutputFormat` переносить `enum` в опис і API їх не форсує.
- **`readEvents` / SSE**: старт XRANGE за мілісекундною частиною `Last-Event-ID` з відсіканням
  попередніх записів у коді (однаково в Redis і `ioredis-mock`).

## Запуск у Docker (локально)

Один образ (`docker/Dockerfile`) для API і воркера; Redis з AOF; томи для Redis і `DATA_DIR`.

```bash
cp .env.example .env          # ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, ADMIN_EMAILS; APP_PASSWORD — опційно
docker compose up --build     # перша збірка ~5–10 хв: браузери + перевірочний 2-с рендер
```

Відкрити `http://localhost:3000` (порт — `PORT` з `.env`). Якщо задано `APP_PASSWORD`, браузер спершу попросить
його (логін будь-який). Старт проєкту потребує акаунта з кредитами — див. [Користувачі, кредити, адмін](#користувачі-кредити-адмін);
посилання активації — у `docker compose logs api` або в томі `data` (`/data/outbox`). Статистика — `http://localhost:3000/stats`
(лише для `ADMIN_EMAILS`).

- `api` — `apps/api` (HTTP, SSE, чат-сторінка); `worker` — `apps/worker` (усі черги BullMQ + оркестратор);
  `redis` — `redis:7` з `appendonly yes`.
- Том `data` → `/data` (`DATA_DIR`): проєкти, артефакти, `costs.jsonl`, кеш SFX, користувачі й леджер (`users/`), поповнення, outbox листів. Том `redis-data` — черги й події чату.
- Збірка без перевірочного рендера: `docker compose build --build-arg SMOKE=0`.
- Кеш стандартних SFX (раз на деплой, платно):
  `docker compose run --rm -e LIVE=1 worker /app/node_modules/.bin/tsx scripts/sfx-cache.ts`.
- Кілька воркерів за чергами: `WORKER_QUEUES=render,cpu` в окремому сервісі (дефолт — усі черги в одному процесі).
- Логи: `docker compose logs -f worker`. Зупинка: `docker compose down` (томи лишаються; `-v` — видалити дані).

## Деплой на сервер (HTTPS)

Потрібен Linux-сервер з Docker (орієнтовно 4 ядра, 8 ГБ), домен з A-записом на сервер, відкриті порти 80 і 443.

```bash
git clone <repo> adcreative && cd adcreative
cp .env.example .env
# у .env: ключі API, APP_DOMAIN=demo.example.com, ADMIN_EMAILS=you@example.com,
#         REMOTION_LICENSE_KEY (якщо є Company License); APP_PASSWORD — опційний staging-gate
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

`docker-compose.server.yml` додає Caddy (`docker/Caddyfile`): сертифікат Let's Encrypt для `APP_DOMAIN`
отримується автоматично, SSE проксується без буферизації, порт API назовні не відкривається.
Без `APP_DOMAIN` compose відмовиться стартувати. `APP_PASSWORD` не обов'язковий: доступ тримається на акаунтах,
а пароль лише додає Basic-gate поверх них (наприклад, поки сервіс не відкрито клієнтам). `APP_URL` за замовчуванням
`https://${APP_DOMAIN}` — від нього будуються посилання в листах і checkout. Перевірити конфіг:
`docker compose -f docker-compose.yml -f docker-compose.server.yml config`.
Оновлення: `git pull && docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build`.
Резервна копія даних: том `adcreative_data` (зокрема користувачі й баланси) і `adcreative_redis-data` (історія чатів, сесії, токени активації/скидання).

## Eval

`pnpm eval` проганяє пайплайн без чату по `eval/sites.json` (чекпоінти затверджуються автоматично,
витрати пишуться з `source: "eval"`). Redis не потрібен — черги в пам'яті процесу, але стадії ті самі,
що у воркері. Платно: потрібні ключі в `.env`. Формат списку — [eval/README.md](eval/README.md).

```bash
pnpm eval                                        # → eval/runs/<дата-час>/report.md
pnpm eval --from codegen --run 2026-10-06-1530   # перезапуск етапу і всього після нього на збережених даних
pnpm eval --from qa --run 2026-10-06-1530 --only # лише один етап
ADC_SFX_MODE=storyboard ADC_FILM_REVIEW=off pnpm eval   # той самий список у старому режимі звуку — для порівняння
ADC_MUSIC_PROVIDER=epidemic ADC_FILM_REVIEW=off pnpm eval --sites eval/sites.epidemic.json   # тест Epidemic Sound
```

Порожній список — повідомлення «список порожній» без помилки. Звіт: вартість і час на сайт (настінний
і машинний), частка сцен, що скомпілювались з першої спроби, частка QA pass, частка сцен-шаблонів,
витрати за етапами, таблиця «Звук і рецензія» (`score` рецензента, події поза долею `offBeat`, вимкнені
`muted`, удари, старти сцен поза тактом); відео, постер, стіли, аркуші, `sfx-plan.json`, `sound-sheet.json`
і `review.json` — у `eval/runs/<прогін>/sites/<сайт>/`.

## CLI

```bash
pnpm tsx scripts/cli.ts run https://example.com --formats 9:16,1:1   # діалог у терміналі
pnpm tsx scripts/cli.ts run --text "Шиномонтаж на Сихові…" --photo a.jpg --auto
pnpm tsx scripts/cli.ts stats [--csv]                                 # статистика витрат DATA_DIR
```

`run` працює в тому ж `DATA_DIR`, що й API (проєкти видно на `/stats`), без Redis і браузера;
витрати — з `source: "test"` (або `--source chat`).

## Веб-чат (`apps/api/public`)

Сторінка без збірки: `index.html` — лише точки монтування, стилі — статичний CSS у `public/static/css`
(токени → `tokens.css`, спільні примітиви → `components.css`, далі файл на екран), JS — ES-модулі в
`public/static/js` (vanilla, `// @ts-check` + JSDoc, перевіряє `pnpm typecheck`). Маршрут `GET /static/*`.

```bash
pnpm --filter @adc/api dev      # http://localhost:3000 (інший порт: PORT=3110 pnpm --filter @adc/api dev)
```

- `/?project=<id>` — робочий простір проєкту (GET проєкту + SSE), інакше — стартовий екран.
- `/?mock=1` — програє фікстуру подій «Зерна» (`static/dev/fixture-events.js`) без бекенду, Redis і ключів:
  «Затвердити» запускає наступний сегмент, повідомлення після видачі — ревізію 2.
  Параметри: `&jump=brand|script|storyboard|delivered|failed|revision|revisionDelivered` — одразу в потрібне
  місце, `&speed=2` — швидше, `&fail=1` — помилка після чекпоінта 2 (перевірка «Спробувати ще раз»).
- `/?fixture=<стан>` — статичний `UiState` з `static/dev/fixture-states.js` (`awaitingBrand`, `rendering`,
  `delivered`, …) з dev-діями; для верстки окремого екрана.

Устрій `public/static/js`: `contracts.js` (заморожені типи `UiState`/`Actions`, константи), `store.js`,
`app.js` (роутинг і монтування), `data/` (API, SSE з перепідключенням, чистий `reduce`, дії, mock),
`views/` (по файлу на область/екран; контракт `mount(el, ctx) → { update, destroy }`), `lib/` (таймлайн,
трек сцен — порт `computeTimeline`). DOM — лише через `dom.js` (`textContent`/`setAttribute`):
**`innerHTML`, `eval` та інлайнові `on*` заборонені** (тексти з сайтів клієнтів), це перевіряє
`test/ui/integration.test.ts`.

Дизайн-еталон — `docs/design/AdCreative Reference.dc.html` (токени T, компоненти C, екрани S, стани X);
відкривати через локальний сервер: `npx serve docs/design`. Тести UI (happy-dom):
`pnpm --filter @adc/api exec vitest run test/ui` (повний прохід у mock — `test/ui/integration.test.ts`).

## Інтеграційний тест

`pnpm --filter @adc/integration test` — пайплайн від URL локального сайту-фікстури через три чекпоінти до
5-секундних mp4 у двох форматах: справжні краулер, бандл і рендер Remotion, оркестратор і стадії;
відповіді LLM і ElevenLabs — записані (`tests/integration/fixtures/llm/`). Перевіряє і `costs.jsonl`
(Anthropic з хешами промптів, ElevenLabs, Remotion), і `pnpm eval` (зокрема `--from`). Потрібні браузери:
`pnpm exec playwright install chromium` і `pnpm --filter @adc/render exec remotion browser ensure`. ~2 хв.
