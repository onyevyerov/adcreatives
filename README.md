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
