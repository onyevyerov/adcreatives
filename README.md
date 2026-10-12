# AdCreative

Демо-сервіс: URL сайту бізнесу (+ фото) → бренд-кіт → сценарій → код сцен (Remotion) → музика й SFX →
рекламні motion-відео 15–30 с у форматах 9:16 / 1:1 / 16:9. Діалог у web-чаті з трьома чекпоінтами.

Специфікація: [docs/superpowers/specs/2026-10-06-adcreative-design.md](docs/superpowers/specs/2026-10-06-adcreative-design.md),
повне ТЗ з блоками робіт: [docs/superpowers/specs/adcreative-tz-v2.md](docs/superpowers/specs/adcreative-tz-v2.md).

## Вимоги

- Node.js ≥ 22.12 (прод — Node 22 у Docker)
- pnpm 10 через corepack: `corepack enable` (або `corepack pnpm …` без глобального ввімкнення)
- Docker Desktop — для Redis (на Windows) і повного запуску
- Ключі Anthropic і ElevenLabs — лише для живих прогонів і реальної роботи

## Швидкий старт (розробка)

```bash
corepack enable
pnpm install
cp .env.example .env        # вписати ключі; APP_PASSWORD можна лишити порожнім локально
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
cp .env.example .env          # ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, APP_PASSWORD
docker compose up --build     # перша збірка ~5–10 хв: браузери + перевірочний 2-с рендер
```

Відкрити `http://localhost:3000` (порт — `PORT` з `.env`), ввести пароль (`APP_PASSWORD`, логін будь-який),
вставити URL сайту. Статистика — `http://localhost:3000/stats`.

- `api` — `apps/api` (HTTP, SSE, чат-сторінка); `worker` — `apps/worker` (усі черги BullMQ + оркестратор);
  `redis` — `redis:7` з `appendonly yes`.
- Том `data` → `/data` (`DATA_DIR`): проєкти, артефакти, `costs.jsonl`, кеш SFX. Том `redis-data` — черги й події чату.
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
# у .env: ключі API, APP_PASSWORD (обов'язково не порожній), APP_DOMAIN=demo.example.com,
#         REMOTION_LICENSE_KEY (якщо є Company License)
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

`docker-compose.server.yml` додає Caddy (`docker/Caddyfile`): сертифікат Let's Encrypt для `APP_DOMAIN`
отримується автоматично, SSE проксується без буферизації, порт API назовні не відкривається.
Без `APP_DOMAIN` або з порожнім `APP_PASSWORD` compose відмовиться стартувати.
Оновлення: `git pull && docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build`.
Резервна копія даних: том `adcreative_data` (і `adcreative_redis-data` для історії чатів).

## Eval

`pnpm eval` проганяє пайплайн без чату по `eval/sites.json` (чекпоінти затверджуються автоматично,
витрати пишуться з `source: "eval"`). Redis не потрібен — черги в пам'яті процесу, але стадії ті самі,
що у воркері. Платно: потрібні ключі в `.env`. Формат списку — [eval/README.md](eval/README.md).

```bash
pnpm eval                                        # → eval/runs/<дата-час>/report.md
pnpm eval --from codegen --run 2026-10-06-1530   # перезапуск етапу і всього після нього на збережених даних
pnpm eval --from qa --run 2026-10-06-1530 --only # лише один етап
```

Порожній список — повідомлення «список порожній» без помилки. Звіт: вартість і час на сайт (настінний
і машинний), частка сцен, що скомпілювались з першої спроби, частка QA pass, частка сцен-шаблонів,
витрати за етапами; відео, постер, стіли й аркуші — у `eval/runs/<прогін>/sites/<сайт>/`.

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
