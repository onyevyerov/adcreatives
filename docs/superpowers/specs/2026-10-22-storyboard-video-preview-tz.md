# ТЗ: Відео-превʼю на чекпоінті 3 (розкадровка)

## 1. Мета і контекст

Зараз на ЧП3 клієнт бачить лише 2 стіли на сцену (50% і 90%): з них не видно руху, переходів і темпу, тож незрозуміло, як сцена виглядатиме у фіналі. Даємо на ЧП3 справжнє відео ролика в основному форматі: щойно відкривається розкадровка, у фоні стартує рендер основного формату (наявний механізм `speculativeRender`), і коли mp4 готовий — він зʼявляється в картці розкадровки з плеєром; кожну сцену можна програти окремо. Після «Затвердити» звичайний рендер перевикористовує цей mp4 за `inputsHash` (`apps/worker/src/render.ts`), тож видача основного формату стає майже миттєвою.

Монорепо `adcreative` (pnpm, TypeScript, vitest, biome). Зачіпає: `packages/shared` (схеми, tuning, черга), `packages/pipeline` (машина, драйвер, чекпоінти), `apps/worker` (стадія render), `apps/api/public` (UI ЧП3).

**Очікувані витрати (довідка).** Рендер ролика 30 с 9:16 на тестовій машині — 64 с, облік Remotion — `$0.01` за рендер (`config/prices.json`). Затвердили без правок — додаткових витрат немає (рендер перевикористовується). Кожне коло правок на ЧП3 — +1 рендер основного формату (~1 хв CPU). Черга `render` має `concurrency: 1` на весь сервіс, тому превʼю мають нижчий пріоритет за оплачені рендери (B1).

**Поза скоупом:** превʼю неосновних форматів (для них лишаються аркуші); окремі кліпи на сцену; зміна якості фінального рендеру; кредити за превʼю; показ кадрів стрічки (`strips/`).

### Поточний стан (на що спираємось)

- `Tuning.speculativeRender` (`ADC_SPECULATIVE_RENDER`, дефолт off): `maybeJoin` → `startSpeculativeRender` ставить `render { format, speculative: true }` з jobId-суфіксом `spec-<format>` на всі формати (`packages/pipeline/src/machine.ts`, ~1058–1072).
- Завершення спекулятивного job машина ігнорує: `onStageEvent` → `if (isSpeculative(job)) return;` (~711).
- Стадія render у спекулятивному режимі не пише прогрес у чат; mp4 → `rev/<n>/renders/<format>.mp4`, поруч `renders/<format>.meta.json` з `inputsHash`; job з тим самим хешем → `reused: true`, без рендеру.
- `/files/…` віддає mp4 з `Accept-Ranges` і 206 (`apps/api/src/routes/files.ts`) — перемотування працює. mp4 Remotion має `moov` на початку (faststart) — відтворення стартує до повного завантаження (~11 МБ на 30 с).
- Нова ревізія (правка) прибирає з `outstanding` усі не-IO job'и, але вже поставлений у BullMQ спекулятивний рендер старої ревізії все одно виконається й займе єдиний слот черги `render`.

## 2. Крок 0 — заморожені інтерфейси (окремий PR, робиться першим)

Поки Крок 0 не влито в `main`, паралельні блоки не стартують.

### 0.1 Схеми подій — `packages/shared/src/schemas/events.ts`

```ts
/** Таймінг сцени у фільмі (з урахуванням переходів — `computeTimeline`). */
export const SceneTiming = z.object({
  sceneId: z.string(),
  /** Початок сцени у фільмі, мс: `framesToMs(timelineScene.from, fps)`. */
  fromMs: z.number().int().nonnegative(),
  /** Тривалість сцени, мс: `framesToMs(timelineScene.durationInFrames, fps)` (переходи всередині). */
  durationMs: z.number().int().positive(),
});
export type SceneTiming = z.infer<typeof SceneTiming>;

// StoryboardCheckpointPayload — два АДИТИВНІ поля (старі події мають лишатися валідними):
  /** Таймінг усіх сцен фільму. Відсутнє — старі події; [] — таймінг не порахувався. */
  timeline: z.array(SceneTiming).optional(),
  /** Відео-превʼю: формат, що рендериться (основний). null — превʼю вимкнене; відсутнє — старі події. */
  preview: z.object({ format: Format }).nullable().optional(),

/** Відео-превʼю ЧП3 готове або не вдалося. */
export const PreviewEvent = z.object({
  type: z.literal("preview"),
  at: IsoDate,
  rev: z.number().int(),
  format: Format,
  state: z.enum(["ready", "failed"]),
  /** URL mp4 (/files/…); null, якщо state = "failed". */
  url: z.string().nullable(),
});

// ChatEvent: додати PreviewEvent у discriminatedUnion.
```

Експорт `SceneTiming`, `PreviewEvent` через `packages/shared/src/schemas/index.ts` (якщо там явний перелік).

### 0.2 Перемикач — `packages/shared/src/tuning.ts`

- `storyboardPreview: z.boolean().default(true)`; `TUNING_ENV.storyboardPreview = "ADC_STORYBOARD_PREVIEW"`; додати в `BOOLEAN_FIELDS`.
- README, таблиця «Перемикачі генерації (`ADC_*`)»: рядок `ADC_STORYBOARD_PREVIEW | on | off — на ЧП3 без відео-превʼю (лише стіли)`.
- `.env.example`: закоментований рядок `# ADC_STORYBOARD_PREVIEW=on`.

### 0.3 Типи машини — `packages/pipeline/src/machine.ts` (лише типи, без логіки)

```ts
// StepContext
  /**
   * `Tuning.storyboardPreview`: на вході в `awaiting_storyboard` рендерити основний формат як
   * відео-превʼю ЧП3. Не задано — false (драйвер ставить з env).
   */
  storyboardPreview?: boolean;

// Effect
  | {
      type: "checkpoint"; checkpoint: Checkpoint; rev: number; changedScenes: string[] | null;
      /** Формат відео-превʼю (лише для storyboard); null / не задано — превʼю немає. */
      preview?: Format | null;
    }
  /** Відео-превʼю ЧП3 дорендерилось (ok) або впало. */
  | { type: "preview"; rev: number; format: Format; ok: boolean }
```

У `packages/pipeline/src/driver.ts` → `runEffect` додати заглушку `case "preview": return;` (щоб typecheck пройшов; реалізація — B3).

### 0.4 Фронтенд-контракт — `apps/api/public/static/js/contracts.js`

- `EVENT_TYPES`: + `"preview"`.
- Новий typedef і поле в `CheckpointEntry`:
  ```js
  /** @typedef {{ format: Format, state: "pending" | "ready" | "failed", url: string | null }} PreviewState */
  /** @typedef {{ rev: number, at: string, payload: CheckpointPayload, state: "open" | "approved" | "superseded", preview?: PreviewState | null }} CheckpointEntry */
  ```

### 0.5 Тести Кроку 0

- `packages/shared/test/events.test.ts`: `PreviewEvent` (ready з url, failed з null) парситься через `ChatEvent`; `StoryboardCheckpointPayload` без нових полів (стара подія) і з ними — валідні.
- `packages/shared/test/tuning.test.ts`: дефолт `storyboardPreview === true`; `ADC_STORYBOARD_PREVIEW=off|0` → false.
- `apps/api/test/ui/contracts.test.ts`: якщо є звірка `EVENT_TYPES` ↔ `ChatEvent` — оновити.

Команди:
```
pnpm --filter @adc/shared exec vitest run test/events.test.ts test/tuning.test.ts
pnpm --filter @adc/api exec vitest run test/ui/contracts.test.ts test/ui/sse.test.ts
pnpm --filter @adc/shared typecheck && pnpm --filter @adc/pipeline typecheck && pnpm --filter @adc/api typecheck
```

## 3. Блоки робіт

### B1: Черга рендеру — пріоритет превʼю і застарілі job'и

- **Володіє:** `packages/shared/src/bullmq.ts`, `packages/shared/src/queue.ts` (лише нова константа), `apps/worker/src/render.ts`, `packages/shared/test/bullmq.test.ts`, `apps/worker/test/render.test.ts`.
- **Залежить від:** Крок 0 (тип `RenderParams.speculative` уже є).
- **Зробити:**
  1. `queue.ts`: `export const SPECULATIVE_RENDER_PRIORITY = 100;`. `BullQueue.enqueueStage`: для `job.stage === "render"` з `params.speculative === true` додати `priority: SPECULATIVE_RENDER_PRIORITY`; звичайні job — без змін. Перевірити семантику встановленої BullMQ 6.x: job без пріоритету мають оброблятися раніше за prioritized. Якщо у 6.x інакше — звичайним рендерам `priority: 1`, спекулятивним `100`; зафіксувати в коментарі.
  2. `createRenderStage`: одразу після `readProject` — якщо `ctx.params.speculative === true` і `project.rev !== ctx.rev`, не рендерити: `throw new StageError("спекулятивний рендер застарілої ревізії", "superseded", "Превʼю застаріло.", false)`. Машина таку подію і так ігнорує (job не в `outstanding`).
  3. Облік: для спекулятивного рендеру `detail` у `ctx.cost.record` — `preview ${format}` замість `render ${format}`.
- **Критерії приймання:** спекулятивний render job додається в BullMQ з `priority`, звичайний — без; спекулятивний рендер застарілої ревізії не викликає `bundleJob`/`renderMedia`; запис витрат спекулятивного рендеру має `detail: "preview <format>"`; повторний звичайний job після спекулятивного — `reused: true` (наявна поведінка не зламана).
- **Тести:** `pnpm --filter @adc/shared exec vitest run test/bullmq.test.ts && pnpm --filter @adc/worker exec vitest run test/render.test.ts`
- **Паралельність:** одночасно з B2, B3, B4.

### B2: Машина станів — старт превʼю і подія готовності

- **Володіє:** `packages/pipeline/src/machine.ts` (логіка; типи вже з Кроку 0), `packages/pipeline/test/machine.test.ts`.
- **Залежить від:** Крок 0.
- **Зробити:**
  1. `maybeJoin`: `const previewFormat = d.ctx.speculativeRender || d.ctx.storyboardPreview ? primaryFormat(d.project.formats) : null;` → у checkpoint-effect `preview: previewFormat`.
  2. Старт рендерів: `speculativeRender` → як зараз, усі формати; інакше `storyboardPreview` → лише основний формат. jobId-суфікс той самий: `spec-<format>`.
  3. `onStageEvent`: замість мовчазного `return` для спекулятивного job — `onSpeculativeDone(d, job, ev)`: якщо формат job === `primaryFormat(d.project.formats)` → `d.effects.push({ type: "preview", rev: ev.rev, format, ok: ev.type === "stage_done" })`. Статус, `failedJobs`, видача — без змін (як зараз). Effect `cost` лишається до цієї гілки.
  4. Переконатися (grep `setStatus("awaiting_storyboard")`), що вхід у ЧП3 є лише через `maybeJoin`; якщо є інші місця — та сама логіка.
- **Критерії приймання:**
  - `ctx()` без прапорів → як зараз: жодних спекулятивних job, checkpoint-effect `preview: null`.
  - `storyboardPreview: true` → рівно один job `render { format: <основний>, speculative: true }` з суфіксом `spec-<основний>`; effect `preview` = основний формат.
  - `speculativeRender: true` → спекулятивні job на всі формати; `preview` = основний.
  - спекулятивний `stage_done` основного формату → effect `{ type: "preview", ok: true }`; `stage_failed` → `ok: false`; неосновного — без preview-effect; статус лишається `awaiting_storyboard`, `delivery` немає.
  - подія спекулятивного job старої ревізії → ігнор (як зараз).
  - approve після готового превʼю → звичайні render job на всі формати (перевикористання — справа воркера).
- **Тести:** `pnpm --filter @adc/pipeline exec vitest run test/machine.test.ts` (оновити наявний describe «speculative render»).
- **Паралельність:** одночасно з B1, B3, B4.

### B3: Драйвер і картка ЧП3

- **Володіє:** `packages/pipeline/src/driver.ts`, `packages/pipeline/src/checkpoints.ts`, `packages/pipeline/test/driver.test.ts`, `packages/pipeline/test/checkpoints.test.ts`.
- **Залежить від:** Крок 0; e2e-тест — від B2 (див. нижче).
- **Зробити:**
  1. `buildContext`: тип `tuning` у `DriverDeps` + `"storyboardPreview"`; `if (tun.storyboardPreview) ctx.storyboardPreview = true`.
  2. `buildStoryboardCheckpoint(storage, project, rev, { templateScenes, changedScenes, preview })`:
     - `payload.preview = preview ? { format: preview } : null`;
     - `payload.timeline` — для **усіх** сцен (не лише змінених) з `computeTimeline(storyboard)`: `{ sceneId: s.id, fromMs: framesToMs(s.from, fps), durationMs: framesToMs(s.durationInFrames, fps) }`; `TimelineError` → `timeline: []` + `logger.warn`.
  3. `runEffect` → `case "checkpoint"`: передати `preview: effect.preview ?? null`.
  4. `case "preview"`: новий `buildPreviewEvent(storage, project, rev, format, ok)` у `checkpoints.ts`: `ok` і `storage.exists(rp.render(format))` → `{ type: "preview", rev, format, state: "ready", url: storage.publicUrl(key) }`, інакше `{ state: "failed", url: null }`; емісія через `emitAll`. Збій ефекту — лише `logger.warn`, **без** error-події в чат (превʼю необовʼязкове; список у catch для `checkpoint`/`delivery` не розширювати).
- **Критерії приймання:** payload ЧП3 має `timeline` з урахуванням перекриття переходів (старт сцени 2 = тривалість сцени 1 − перехід) і `preview`; ефект preview дає `ready` з URL, коли mp4 є, і `failed`, коли немає або `ok: false`; усі події проходять `ChatEvent.parse`.
- **Тести:** `pnpm --filter @adc/pipeline exec vitest run test/checkpoints.test.ts test/driver.test.ts`
- **e2e (після злиття B2, у гілці B3 після rebase):** у `driver.test.ts` — «вхід у ЧП3 з `storyboardPreview` → у стрімі `checkpoint` з `preview.format`, далі спекулятивний `stage_done` → подія `preview` `ready`».
- **Паралельність:** код — одночасно з B1, B2, B4; e2e-тест і merge — після B2.

### B4: UI ЧП3 — плеєр превʼю

- **Володіє:** `apps/api/public/static/js/data/reduce.js`, `apps/api/public/static/js/views/cp-board.js`, `apps/api/public/static/css/cp-board.css`, `apps/api/public/static/dev/fixtures/workspace.js` (і `apps/api/public/static/dev/fixture-events.js`, якщо події ЧП3 живуть там), `apps/api/test/ui/reduce.test.ts`, `apps/api/test/ui/cp-board.test.ts`.
- **Залежить від:** Крок 0 (контракт подій і `PreviewState`); бекенд не потрібен — працює на фікстурах.
- **Reducer (`reduce.js`):**
  - `checkpoint` зі `storyboard`: `preview = payload.preview ? { format: payload.preview.format, state: "pending", url: null } : null`; інші чекпоінти поля не мають.
  - `preview`: якщо `checkpoints.storyboard?.rev === ev.rev` → новий entry з `preview: { format, state, url }`; інакше стан без змін. Повтор події — ідемпотентно. У `feed` подія не потрапляє.
- **View (`cp-board.js`):**
  - Новий рядок «Превʼю» між вступом і стілами (`specRow("cd-preview", "Превʼю", …)`), лише якщо `entry.preview` не null:
    - `pending`: заглушка в пропорції формату зі смугами (як `cd-still stripes`) + `PREVIEW_PENDING = "Відео-превʼю рендериться — зазвичай 1–2 хв. Затвердити можна, не чекаючи."`;
    - `ready`: `<video controls playsinline preload="metadata">`, `src` лише через `safeMediaUrl`; розміри — `aspect-ratio` за форматом, vertical: висота ≤ 480 px, square ≤ 400 px, landscape — ширина колонки;
    - `failed`: `PREVIEW_FAILED = "Превʼю не вдалося зібрати. Розкадровку можна затвердити — фінальне відео зрендериться як завжди."`.
  - Сцени: коли превʼю `ready` і `payload.timeline` непорожній, кожна картка `.cd-scene` отримує кнопку «▶ Сцена» (`aria-label="Програти сцену N"`): плеєр перемотується на `fromMs`, грає і стає на паузу на `fromMs + durationMs` (через `timeupdate`, допуск ~1 кадр). Під час будь-якого відтворення картка поточної сцени має клас `cd-scene--playing` (за `currentTime`; при перекритті переходу — пізніша сцена).
  - Взаємовиключення з плеєром музики: play відео → пауза музики; play музики → пауза відео.
  - Оновлення: зміна лише `entry.preview` **не** перебудовує дошку (музика не обривається, стіли не перезавантажуються) — оновлюються рядок превʼю і кнопки сцен. Плеєр з тим самим URL переноситься без перестворення `<video>` (як `musicRow`). `destroy()` ставить відео на паузу й прибирає слухачі.
  - Старі події (без `preview`/`timeline`) — ні рядка, ні кнопок.
  - Тексти — лише через `textContent`; нових кольорів не вводити, токени з `tokens.css`, кнопки — у стилі `cd-player`. Орієнтир макета — `docs/design/AcWorkspace.dc.html` (ЧП3). Ширина 375 px — без горизонтального скролу.
- **Фікстури dev:** `n5-cp3-preview-pending`, `n5-cp3-preview-ready` (`/static/media/sample-9x16.mp4`), `n5-cp3-preview-failed`.
- **Критерії приймання:** три стани рендеряться; кнопка сцени грає рівно сцену; підсвітка сцени під час відтворення; подія `preview` не перебудовує дошку; старі події без змін у вигляді.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/reduce.test.ts test/ui/cp-board.test.ts`
- **Паралельність:** одночасно з B1, B2, B3.

## 4. Карта володіння файлами

| Власник | Файли |
|---|---|
| Крок 0 | `packages/shared/src/schemas/events.ts`, `packages/shared/src/schemas/index.ts`, `packages/shared/src/tuning.ts`, `packages/shared/test/events.test.ts`, `packages/shared/test/tuning.test.ts`, `packages/pipeline/src/machine.ts` (**лише типи**), `packages/pipeline/src/driver.ts` (**лише заглушка `case "preview"`**), `apps/api/public/static/js/contracts.js`, `apps/api/test/ui/contracts.test.ts`, `README.md`, `.env.example` |
| B1 | `packages/shared/src/bullmq.ts`, `packages/shared/src/queue.ts`, `apps/worker/src/render.ts`, `packages/shared/test/bullmq.test.ts`, `apps/worker/test/render.test.ts` |
| B2 | `packages/pipeline/src/machine.ts`, `packages/pipeline/test/machine.test.ts` |
| B3 | `packages/pipeline/src/driver.ts`, `packages/pipeline/src/checkpoints.ts`, `packages/pipeline/test/driver.test.ts`, `packages/pipeline/test/checkpoints.test.ts` |
| B4 | `apps/api/public/static/js/data/reduce.js`, `apps/api/public/static/js/views/cp-board.js`, `apps/api/public/static/css/cp-board.css`, `apps/api/public/static/dev/fixtures/workspace.js`, `apps/api/public/static/dev/fixture-events.js`, `apps/api/test/ui/reduce.test.ts`, `apps/api/test/ui/cp-board.test.ts` |

- Спільні файли (схеми, tuning, контракт фронтенду, типи машини, README, `.env.example`) змінюються **лише** в Кроці 0. Якщо блоку знадобилось змінити контракт — стоп, окремий PR у Крок 0, решта блоків rebase.
- `package.json` / `pnpm-lock.yaml` — ніхто: нових залежностей не потрібно. Якщо знадобиться — узгодити до старту.
- `apps/worker` поза `render.ts`, `apps/remotion`, `packages/render`, `packages/director` — не чіпаємо.

## 5. Спільні ресурси й ізоляція

- Юніт-тести всіх блоків — `MemoryQueue`, `LocalStorage` у тимчасовій теці, happy-dom: ізоляції не потребують.
- Redis/BullMQ, `.data/` і порти `docker-compose.yml` — **спільні для всіх worktree** (worktree їх не ізолює). Ручну перевірку через `docker compose up` робити лише в інтеграційній гілці, однією сесією. Якщо блоку конче треба живий стек — у його worktree окремі `COMPOSE_PROJECT_NAME`, `DATA_DIR` і порти через локальний `.env`.
- Свіжий worktree: `pnpm install`.

## 6. План інтеграції

- **Порядок:** Крок 0 → хвиля 1 (B1, B2, B3, B4 паралельно) → злиття: B2 → B3 (rebase на B2 + e2e-тест) → B1 → B4.
- **Інтеграційна гілка:** `feat/storyboard-preview`. Після кожного merge — rebase решти гілок від неї, щоб конфлікти спливали рано й малими порціями.
- **Після хвилі 1** (усі блоки злиті) — тести блоків хвилі разом + smoke, без повного прогону:
  ```
  pnpm --filter @adc/shared exec vitest run test/bullmq.test.ts test/events.test.ts test/tuning.test.ts
  pnpm --filter @adc/worker exec vitest run test/render.test.ts
  pnpm --filter @adc/pipeline exec vitest run test/machine.test.ts test/checkpoints.test.ts test/driver.test.ts
  pnpm --filter @adc/api exec vitest run test/ui/reduce.test.ts test/ui/cp-board.test.ts test/ui/contracts.test.ts test/ui/sse.test.ts
  ```
  Smoke: `pnpm typecheck`.
- **Ручна перевірка в інтеграційній гілці (`docker compose up`):**
  1. ЧП3 відкривається → рядок «Превʼю» у стані pending; за ~1–2 хв → плеєр; у відео є музика і SFX.
  2. «▶ Сцена» грає лише цю сцену; при повному відтворенні підсвічується поточна сцена; відео й музика не грають одночасно.
  3. «Затвердити» → основний формат видається майже одразу; у `costs.jsonl` проєкту для основного формату один запис `preview <format>` і жодного `render <format>`.
  4. «Правки», поки превʼю pending → у логах воркера `superseded` для старої ревізії; превʼю нової ревізії стартує на новому ЧП3.
  5. `ADC_STORYBOARD_PREVIEW=off` → рядка «Превʼю» немає, спекулятивних job немає.
  6. Оновлення сторінки (replay SSE) — стан превʼю відновлюється.
  7. Ширина 375 px — плеєр і кнопки не ламають верстку.

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | Лише команда з поля «Тести» блоку + `pnpm exec biome check <змінені файли>` | Ні |
| Після Кроку 0 | Команди з 0.5 + споживачі змінених схем: `pnpm --filter @adc/pipeline exec vitest run test/checkpoints.test.ts test/driver.test.ts test/machine.test.ts` і `pnpm --filter @adc/api exec vitest run test/sse.test.ts test/ui/reduce.test.ts test/ui/cp-board.test.ts` | Ні |
| Після злиття хвилі 1 | Обʼєднана команда з розділу 6 + `pnpm typecheck` | Ні |
| Блок змінив спільний файл | Заборонено (див. розділ 4) — лише через Крок 0 | — |
| **Фінал — усе злито, ТЗ виконано** | **`pnpm test && pnpm typecheck && pnpm lint`** (+ `pnpm smoke`, якщо в середовищі є Chromium) | **Так, один раз** |

Правила для агента (дослівно):
- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на main до змін; якщо падало — не чіпай, лише зафіксуй у звіті.»
- «Фінальний прогін — це ворота перед деплоєм: поки він не зелений, ТЗ не вважається виконаним.»

## 8. Review і Definition of Done

**На блок:** тести блоку зелені; `pnpm --filter <пакет> typecheck` зелений; `biome check` чистий на змінених файлах; правок поза власними файлами немає; diff проти інтеграційної гілки маленький і зрозумілий; коментарі — українською, у стилі сусіднього коду.

**На ТЗ:** фінальний `pnpm test && pnpm typecheck && pnpm lint` зелений (або падіння підтверджено як наявні на main до змін); ручний чекліст розділу 6 пройдено; `ADC_STORYBOARD_PREVIEW` задокументовано в README і `.env.example`.

## 9. Запуск у Claude Code

- **Просто (рекомендовано):** Крок 0 — одна сесія Desktop. Після merge — чотири окремі сесії Desktop (B1, B2, B3, B4), кожна автоматично отримує свій worktree.
- **CLI-еквівалент:** `claude -w storyboard-preview-step0`; потім `claude -w storyboard-preview-b1`, `… -b2`, `… -b3`, `… -b4` в окремих терміналах.
- **Субагенти в одній сесії:** `isolation: worktree` у frontmatter кастомного субагента (`.claude/agents/*.md`) або попросити «use worktrees for your agents».
- Нагадування: `main` тримати чистим; не більше 4 паралельних потоків; у свіжому worktree — `pnpm install`; після merge — `git worktree remove`.
