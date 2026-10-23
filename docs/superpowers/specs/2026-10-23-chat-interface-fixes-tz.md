# ТЗ: Чат і робочий простір — витяжки замість стін тексту, детальний прогрес, Crealab, єдина мова, вибір форматів з підтвердженням

## 1. Мета і контекст

Шість правок інтерфейсу проєкту за скриншотами (нумерація пунктів = нумерація скриншотів):

1. **Стіна тексту в чаті на кожному чекпоінті.** ЧП1 дублює в чаті весь бренд-кіт (факти з URL, формати, мова), ЧП2 — усі сцени й музичний бриф англійською. Треба: на ЧП1 усе лише в панелі праворуч, на ЧП2/ЧП3 — коротка витяжка (2–4 рядки, шаблон у коді, без LLM).
2. **Прогрес з одним рядком «Пишу сценарій…».** Треба чекліст підкроків поточної стадії: ✓ виконані (з часом), спінер на поточному, сірі майбутні. Заодно прибрати дубль «✓ Пишу сценарій… / ○ Пишу сценарій…» у чаті.
3. **Лого AdCreative на домені crealab.ai.** Замінити бренд на **Crealab** скрізь, де його бачить користувач.
4–5. **Змішані мови на ЧП2.** Концепт і хук — українською, а «Рух», музика — англійською. Правило: усе службове для власника — українською; тексти на екрані відео (headline/sub/items) — мовою відео. Плюс концепт набраний гігантським `display-m` — привести до одного стилю з рештою екрана.
6. **Вибір форматів одразу летить у чат** (`setFormats` → debounce → `Формати: …`), останній формат не знімається. Треба: у панелі вибір — чернетка (можна вмикати/вимикати будь-що, зокрема дефолтний 9:16), у чат нічого не йде; на ЧП1 «Затвердити» одним кліком фіксує формати + мову й затверджує, у чат летить один рядок вибору.

Монорепо `adcreative` (pnpm, TypeScript, vitest, biome). Зачіпає: `packages/shared` (схеми, i18n, кроки прогресу), `packages/pipeline` (чекпоінти, машина), `packages/director`, `packages/brandkit`, `packages/crawler` (події прогресу), `prompts/` (мова полів розкадровки), `apps/api/src` (команда approve, бренд у листах), `apps/api/public` (UI).

### Поточний стан (на що спираємось)

- Тексти чекпоінтів збирає `packages/pipeline/src/checkpoints.ts`: `buildBrandCheckpoint` (~87–106: `formatBrandSummaryText` + `askFormats` + `askLanguage`), `buildScriptCheckpoint` (~125–189: концепт, наскрізний об'єкт, усі сцени з items, музика, ⚠), `buildStoryboardCheckpoint` (~293–307: QA, рецензія, шаблонні сцени). Картка чекпоінта в чаті («Чекпоінт 1 — бренд · … — праворуч», кнопки) уже є і лишається.
- `brandkit.questions` завжди `[]` (`packages/brandkit/src/finalize.ts:206`) — переносити питання в панель не треба.
- Прогрес: `ProgressEvent { stage, label, done, total }` (`packages/shared/src/schemas/events.ts:27`). Стадії `brandkit` і `storyboard` шлють по одному рядку на весь LLM-виклик (`brandkit/src/stage.ts:81`, `director/src/stages/storyboard.ts:283`). «Пишу сценарій…» шлють двічі: машина при approve (`pipeline/src/machine.ts:377`) і стадія при старті — звідси дубль у чаті. Центральну панель малює `apps/api/public/static/js/views/stage-progress.js` (`stageLog` для brandkit/scripting, дві гілки для directing).
- Вибір форматів: `cp-brand.js` `formatTile` → `toggleFormat` (повертає `null`, якщо знімають останній) → `actions.setFormats` (`data/actions.js:333`) → через `FORMATS_DEBOUNCE_MS` шле повідомлення `Формати: …`; `setLanguage` шле `Мова відео: …` миттєво. Бекенд розбирає їх `preparseIntent` (`pipeline/src/intake.ts`). На ЧП3 `cp-board.js` теж використовує `setFormats`, і там зміна форматів = ревізія (`machine.ts:670`).
- Мова полів розкадровки задана в `prompts/storyboard.md` (розділ «Languages and remaining fields»): `concept`, `hook` — українською; `motionIntent`, `events`, `throughline`, `musicBrief` — англійською (їх читають інші моделі, міняти не можна). `cp-script.js:304` показує `motionIntent` як «Рух», `:305` — сирі id фактів «✓ f7, f35», `:370` — концепт у `display-m`.
- Назва «AdCreative»: `public/index.html` (title), `views/topbar.js:100`, `views/start.js:329`, `views/checkout.js:236`, `contracts.js:423` (`ROLE_LABELS.assistant`), `src/routes/auth.ts:69–79` (листи), `src/auth.ts:27` (realm), `public/static/dev/fixtures/_base.js`.

**Поза скоупом:** переклад інтерфейсу на інші мови; текст повідомлення видачі (`buildDelivery` з розбивкою витрат); міграція старих подій — у вже створених проєктах довгі повідомлення лишаються як є; нове графічне лого (робимо текстовий wordmark «Crealab» з наявною крапкою `.wordmark::before`; SVG-лого — окремо, коли буде файл); перейменування пакетів `@adc/*`, репозиторію, CSS-коментарів і docs.

## 2. Крок 0 — заморожені інтерфейси (окремий PR, робиться першим)

Поки Крок 0 не влито в `main`, паралельні блоки не стартують. Усі зміни схем — **адитивні**: старі події й файли мають лишатися валідними.

### 0.1 Подія прогресу з підкроком — `packages/shared/src/schemas/events.ts`

```ts
export const ProgressEvent = z.object({
  type: z.literal("progress"),
  at: IsoDate,
  stage: CostStage,
  label: z.string(),
  done: z.number().int().nullable(),
  total: z.number().int().nullable(),
  /** id підкроку з STAGE_STEPS; відсутній — старі події або стадія з одним кроком (крок береться за `stage`). */
  step: z.string().optional(),
});
```

`emit.progress(stage, label, done?, total?, step?)` — `packages/shared/src/events/emit.ts`; той самий необов'язковий `step` у `progress(ctx, …)` (`packages/director/src/io.ts:163`) і `Draft.progress(stage, label, step?)` (`packages/pipeline/src/machine.ts:206`). Виклики в `machine.ts` Крок 0 одразу оновлює: `:377` → `step: "brief"`, `:411` → `step: "code"`, `:430` → `step: "render"`, `:990` → `"sfx"`, `:1029` → `"review"`, `:1060` → `"review-fix"`.

### 0.2 Перелік підкроків — новий `packages/shared/src/progress-steps.ts` (+ експорт з `index.ts`)

```ts
export interface StageStep {
  id: string;
  /** Підпис у чеклісті (укр.). */
  label: string;
  /** Події progress з цими stage без `step` падають у цей крок (сумісність). */
  stages: CostStage[];
  /** Показується лише якщо почався (fix, review-fix). */
  optional?: boolean;
  /** Гілка для directing: дві колонки. */
  branch?: "scenes" | "music";
}

export const STAGE_STEPS: Record<"crawling" | "brandkit" | "scripting" | "directing" | "rendering", StageStep[]> = {
  crawling: [
    { id: "open",   label: "Відкриваю сайт",              stages: ["crawl"] },
    { id: "pages",  label: "Сканую сторінки",             stages: [] },
    { id: "assets", label: "Завантажую фото й шрифти",    stages: [] },
    { id: "photos", label: "Обробляю фото",               stages: ["ingest"] },
  ],
  brandkit: [
    { id: "read",    label: "Читаю тексти сайту",           stages: ["brandkit"] },
    { id: "look",    label: "Роздивляюсь фото й скриншоти", stages: [] },
    { id: "compose", label: "Складаю бренд-кіт",            stages: [] },
    { id: "verify",  label: "Звіряю факти, кольори й шрифти", stages: [] },
  ],
  scripting: [
    { id: "brief",  label: "Читаю бренд-кіт і сайт",     stages: ["storyboard"] },
    { id: "write",  label: "Пишу концепт і сцени",       stages: [] },
    { id: "fit",    label: "Підганяю тексти під екран",  stages: [] },
    { id: "claims", label: "Звіряю цифри з сайтом",      stages: [] },
  ],
  directing: [
    { id: "code",       label: "Пишу анімацію сцен",      stages: ["codegen", "author"], branch: "scenes" },
    { id: "check",      label: "Перевіряю код сцен",      stages: ["check"],             branch: "scenes" },
    { id: "fix",        label: "Виправляю сцени",         stages: ["fix"],               branch: "scenes", optional: true },
    { id: "stills",     label: "Знімаю кадри",            stages: [],                    branch: "scenes" },
    { id: "qa",         label: "Перевіряю кадри",         stages: ["qa"],                branch: "scenes" },
    { id: "music",      label: "Пишу музику",             stages: ["audio"],             branch: "music" },
    { id: "sfx",        label: "Розставляю звук",         stages: ["sfx"] },
    { id: "review",     label: "Рецензент дивиться ролик", stages: ["review"] },
    { id: "review-fix", label: "Правлю за рецензією",     stages: [],                    optional: true },
  ],
  rendering: [
    { id: "render", label: "Рендер", stages: ["render"] }, // рядок на кожен формат малює UI з done/total
  ],
};
```

`revising` окремого списку не має: UI показує «Розбираю правку» (stage `revise`) і далі кроки тих стадій, що реально запустились (B6).

Дзеркало для фронту — `apps/api/public/static/js/contracts.js` (`export const STAGE_STEPS`), паритет перевіряє `packages/shared/test/parity-contracts.test.ts` (додати кейс).

### 0.3 Команда approve з вибором — `packages/shared/src/queue.ts` + `apps/api/src/routes/projects.ts`

```ts
// queue.ts
| { type: "approve"; rev: number | null; choices?: { formats?: Format[]; language?: Language } }

// projects.ts → CommandBody, гілка approve: додати
choices: z.object({
  formats: z.array(Format).min(1).optional(),
  language: Language.optional(),
}).optional(),
```

Лише схема і проброс `body.choices` у `command` (`projects.ts:415`). Обробку робить B3.

### 0.4 Українські примітки в розкадровці — `packages/shared/src/schemas/storyboard.ts`

```ts
// Scene:
/** Що відбувається в кадрі — 1–2 речення українською для власника (motionIntent лишається англійською для моделей). */
motionNote: z.string().optional(),
// Storyboard:
/** Музика простими словами українською: «Сучасний tech house, впевнений і бадьорий, ~120 BPM». */
musicNote: z.string().optional(),
```

Схема для structured output (LLM) має дозволяти ці поля; `normalizeStoryboard` не повинна їх зрізати (перевірити тестом у Кроці 0).

### 0.5 Тексти — `packages/shared/src/i18n/uk.ts` (власник файлу — Крок 0)

Нові ключі в кінець `I18N_KEYS` з текстами:

```ts
brandCheckpointShort: "Бренд-кіт готовий — перевірте праворуч: палітра, шрифти, лого, факти. Там же оберіть формати й мову відео й натисніть «Затвердити».",
scriptCheckpointSummary: "Сценарій готовий: {scenes} сцен, {seconds} с. Музика: {music}.",
scriptUnverifiedShort: "⚠ {count} твердж. не знайдено на сайті — позначені праворуч. «Затвердити» = ви підтверджуєте, що вони правдиві.",
storyboardCheckpointSummary: "Розкадровка готова: кадри {scenes} сцен і музика — праворуч.",
storyboardIssuesShort: "Зауважень: {count} (автоперевірка {qa}, рецензент {review}) — деталі праворуч.",
storyboardScoreShort: "Оцінка рецензента: {score}/10.",
choicesLine: "Формати: {formats} · Мова відео: {language}",
```

Старі ключі (`askFormats`, `askLanguage`, `scriptScenesHeader`, …) не видаляти — їх читають тести/історія.

### 0.6 Фронт-контракти — `apps/api/public/static/js/contracts.js`, `initial.js`, `data/reduce.js`

- `UiFlags`: `pendingFormats: Format[] | null` — тепер **чернетка до підтвердження** (може бути `[]`); новий `pendingLanguage: Language | null`. `initial.js`: `pendingLanguage: null`.
- `Actions`: `setFormats(formats)` і `setLanguage(lang)` лише пишуть чернетку; `approve()` сам бере чернетку зі стору; новий `applyFormats()` (ЧП3).
- `ProgressItem` у стрічці отримує `step?: string`; `reduce.js` (~90–109) лише прокидає `ev.step` у item (поведінку не міняє — це B4).
- `ROLE_LABELS.assistant = "Crealab"`; новий `export const BRAND_NAME = "Crealab"`. Оновити очікування в `apps/api/test/ui/chat.test.ts`, що стосуються `ROLE_LABELS`.

**Тести Кроку 0:**
```
pnpm --filter @adc/shared exec vitest run test/events.test.ts test/schemas.test.ts test/queue.test.ts test/parity-contracts.test.ts
pnpm --filter @adc/api exec vitest run test/ui/contracts.test.ts test/ui/reduce.test.ts test/ui/chat.test.ts
```

## 3. Блоки робіт

### B1: Витяжки чекпоінтів у чаті (бекенд) — п.1

- **Володіє:** `packages/pipeline/src/checkpoints.ts`, `packages/pipeline/test/checkpoints.test.ts`.
- **Залежить від:** Крок 0 (ключі 0.5, `musicNote` 0.4).
- **Що зробити:**
  - `buildBrandCheckpoint`: текст повідомлення = лише `t("brandCheckpointShort")`. Без `formatBrandSummaryText`, без `askFormats`/`askLanguage` (вибір — у панелі, B3). Подія `checkpoint` з payload — без змін.
  - `buildScriptCheckpoint`: `scriptCheckpointSummary` (кількість сцен, тривалість через `computeTimeline`, музика = `storyboard.musicNote ?? musicBrief.genre`); якщо є непідтверджені — другим рядком `scriptUnverifiedShort`. Жодних headline сцен, концепту чи списку ⚠ у чаті (усе є в `cp-script`).
  - `buildStoryboardCheckpoint`: `storyboardCheckpointSummary` + (за наявності) `storyboardIssuesShort`, `storyboardScoreShort`, `templateScenesNote`. Без переліку зауважень.
  - Кнопки `["approve", "edit"]` лишаються.
- **Критерії приймання:** повідомлення ЧП1 — 1 рядок, ЧП2/ЧП3 — не більше 4 непорожніх рядків; у тексті ЧП2 немає англійських headline і URL; усе прибране з чату є в payload, який рендерить панель (перевірити по полях payload, не по UI).
- **Тести:** `packages/pipeline/test/checkpoints.test.ts` → `pnpm --filter @adc/pipeline exec vitest run test/checkpoints.test.ts`
- **Паралельність:** одночасно з B2, B3, B4, B5, B6, B7.

### B2: Події підкроків у стадіях (бекенд) — п.2

- **Володіє:** `packages/crawler/src/stage.ts`, `packages/brandkit/src/stage.ts`, `packages/director/src/stages/storyboard.ts`, `packages/director/src/stages/check.ts`, `packages/director/src/stages/review.ts`; нові тести `packages/crawler/test/stage-progress.test.ts`, `packages/director/test/storyboard-progress.test.ts`; правки в `packages/brandkit/test/stage.test.ts`.
- **Залежить від:** Крок 0 (0.1, 0.2).
- **Що зробити** (id кроків — строго з `STAGE_STEPS`):
  - crawler: `phase: "pages"` → `step: "pages"` (з done/total), `phase: "assets"` → `step: "assets"`; на старті — `step: "open"`.
  - brandkit: `read` на старті (замість поточного рядка); `look` перед `buildBrandkitInput`/контакт-листом; `compose` перед `llm.structured("brandkit")`; `verify` перед `finalizeBrandKit`.
  - storyboard: прибрати перший `progress(…scriptProgress)` у стадії (його вже шле машина з `step: "brief"`) → далі `write` перед `call()`, `fit` перед `normalize`/`copyfix`, `claims` перед `verifyClaims`. Гілка «взяли з попередньої ревізії» — одразу `claims`.
  - check: «Знімаю кадри N/M» (`check.ts:663`) → `step: "stills"`; решта рядків check — `step: "check"`.
  - review: рядок `reviewFixProgress` (якщо його шле стадія, а не машина) → `step: "review-fix"`.
  - Підписи `label` у подіях = `label` кроку з `STAGE_STEPS` (+ лічильник, де є done/total), щоб старий UI теж показував осмислений текст.
- **Критерії приймання:** на кожну стадію з переліку події з `step` ідуть у порядку `STAGE_STEPS`; немає двох подій поспіль з однаковими `stage`+`step`+`label`; стадія scripting більше не шле дубль «Пишу сценарій…».
- **Тести:** `pnpm --filter @adc/crawler exec vitest run test/stage-progress.test.ts` · `pnpm --filter @adc/brandkit exec vitest run test/stage.test.ts` · `pnpm --filter @adc/director exec vitest run test/storyboard-progress.test.ts test/check-strip.test.ts test/review.test.ts`
- **Паралельність:** одночасно з усіма. Не чіпає `machine.ts` (його `step` проставлено в Кроці 0).

### B3: Формати й мова — чернетка з підтвердженням (ЧП1 і ЧП3) — п.6

- **Володіє:** `apps/api/public/static/js/data/actions.js`, `apps/api/public/static/js/views/cp-brand.js`, `apps/api/public/static/js/views/cp-board.js`, `apps/api/public/static/css/cp-brand.css`, `apps/api/public/static/css/cp-board.css`, `packages/pipeline/src/machine.ts`, `packages/pipeline/src/driver.ts` (лише якщо approve проходить через нього), `apps/api/src/routes/projects.ts` (гілка approve — додати user-повідомлення); тести `apps/api/test/ui/cp-brand.test.ts`, `apps/api/test/ui/cp-board.test.ts`, `apps/api/test/ui/actions.test.ts`, `packages/pipeline/test/machine.test.ts`, `apps/api/test/projects.test.ts`.
- **Залежить від:** Крок 0 (0.3, 0.5, 0.6).
- **Що зробити — фронт:**
  - `toggleFormat` більше не повертає `null`: можна зняти будь-який формат, включно з 9:16 і останнім (чернетка `[]` допустима).
  - `setFormats` → лише `ui({ pendingFormats })`, без таймера і без `send`. `setLanguage` → лише `ui({ pendingLanguage })`. Прибрати `formatsTimer`/`FORMATS_DEBOUNCE_MS` з цього шляху.
  - Мова в `languageGroup`: кнопки керуються `pendingLanguage ?? project.language ?? мова бренд-кіта` (локальна змінна `language` у view прибирається — джерело істини стор).
  - `approve()` на ЧП1: якщо чернетка відрізняється від payload — шле `{ type: "approve", rev, choices: { formats?, language? } }`; після успіху чистить `pendingFormats`/`pendingLanguage`. Працює однаково з кнопки в шапці панелі й з картки в чаті (обидві викликають `actions.approve()`, `chat.js` не чіпаємо).
  - Порожній вибір: «Затвердити» (в панелі і в картці чату) `disabled`, під тайлами — «Оберіть хоча б один формат». Ціновий рядок (`formatsCharge`) рахується від чернетки, як зараз.
  - ЧП3 (`cp-board.js`): ті самі тайли-чернетка; коли чернетка ≠ поточних форматів — з'являється кнопка «Застосувати формати» → `applyFormats()` шле `Формати: …` (поточний шлях `send`, це ревізія) і чистить чернетку. «Затвердити» на ЧП3 при незастосованій чернетці — `disabled` з підказкою «Спершу застосуйте або скиньте формати».
- **Що зробити — бекенд:**
  - `projects.ts`: approve з `choices` додає в стрічку user-повідомлення `t("choicesLine", …)` (як `/messages` на рядку ~167) — це і є «правки летять у чат».
  - `machine.ts`: approve на `awaiting_brand` з `choices` — застосувати `formats`/`language` (наявна `applyAnswers`, `normalizeFormats`) **до** `approveBrand`, одним кроком, без окремого `answersSaved`-повідомлення. На інших статусах `choices` ігноруються (лог warn).
- **Критерії приймання:** клік по тайлу/мові не створює жодного повідомлення й запиту; можна зняти 9:16; при 0 форматів затвердити не можна; «Затвердити» з 1:1 + en → у чаті рядок «Формати: 1:1 · Мова відео: англійська», проєкт іде в scripting з `formats=["square"]`, `language="en"`; затвердження без змін чернетки працює як раніше (без `choices`).
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/cp-brand.test.ts test/ui/cp-board.test.ts test/ui/actions.test.ts test/projects.test.ts` · `pnpm --filter @adc/pipeline exec vitest run test/machine.test.ts`
- **Паралельність:** одночасно з усіма. Єдиний власник `machine.ts` після Кроку 0.

### B4: Прогрес у чаті без дублів — п.1, п.2

- **Володіє:** `apps/api/public/static/js/views/chat.js`, `apps/api/public/static/js/data/reduce.js`, `apps/api/public/static/css/chat.css`; тести `apps/api/test/ui/chat.test.ts`, `apps/api/test/ui/reduce.test.ts`.
- **Залежить від:** Крок 0 (0.6). B2 — не обов'язково (тестувати на фікстурних подіях).
- **Що зробити:**
  - Знайти причину дубля «✓ Пишу сценарій… / ○ Пишу сценарій…» (дві події одного stage з подією між ними, що ламає перевірку `last` у `reduce.js:99`) і виправити: подія з тим самим `stage` і `label`, що й попередній рядок busy-відрізка, рядок не дублює.
  - У чаті busy-відрізок показується **одним** рядком: поточний крок (`label`), після завершення — ✓ з підписом стадії («✓ Сценарій написано» / просто останній label). Детальний чекліст — лише в центральній панелі (B6). У `state.feed` усі події лишаються (їх читає B6).
- **Критерії приймання:** на фікстурі scripting з 4 кроками в чаті 1 рядок прогресу; дубль на подіях машина+стадія не відтворюється; старі фікстури без `step` виглядають як раніше.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/chat.test.ts test/ui/reduce.test.ts`
- **Паралельність:** одночасно з усіма.

### B5: Мова ЧП2 і єдиний вигляд — п.4–5

- **Володіє:** `prompts/storyboard.md`, `prompts/revise.md`, `apps/api/public/static/js/views/cp-script.js`, `apps/api/public/static/css/cp-script.css`; тести `apps/api/test/ui/cp-script.test.ts`, `packages/shared/test/prompts.test.ts` (якщо там перевіряються плейсхолдери), фікстура `apps/api/public/static/dev/fixtures/workspace.js` (лише ЧП2-частина: додати `motionNote`/`musicNote`).
- **Залежить від:** Крок 0 (0.4).
- **Що зробити:**
  - `storyboard.md`, розділ «Languages and remaining fields»: додати `motionNote` (кожна сцена, українською, 1–2 речення простими словами для власника: що бачить глядач, без технічних термінів) і `musicNote` (українською, одне речення). `motionIntent` і `musicBrief` лишаються англійською — не чіпати.
  - `revise.md`: якщо патч змінює `motionIntent` сцени або `musicBrief` — оновити й `motionNote`/`musicNote`.
  - `cp-script.js`: «Рух» = `scene.motionNote`; якщо поля немає (старі розкадровки) — рядок «Рух» не показувати (англійський `motionIntent` власнику не показуємо). Музика = `musicNote ?? genre`. «Факти»: замість id (`f7, f35`) — тексти з `claims.verified` цієї сцени («✓ «+25%», «4080»»); якщо їх немає, а `factIds` є — «✓ підтверджено фактами бренд-кіта».
  - Концепт: з `display-m` на той самий рівень, що заголовки сцен (`display-s`/`body-l`), обмежити ширину рядка; хук — як зараз. Мета — екран читається як один документ, а не плакат + таблиця.
- **Критерії приймання:** на ЧП2 жодного англійського тексту, крім текстів на екрані відео (headline/sub/items, якщо мова відео en); концепт не займає більше ~⅓ першого екрана на 1440×900; старі проєкти без нових полів не ламаються.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/cp-script.test.ts` · `pnpm --filter @adc/shared exec vitest run test/prompts.test.ts` · `pnpm --filter @adc/director exec vitest run test/storyboard-revise.test.ts`
- **Ручна перевірка промпта:** `pnpm eval` на 2–3 сайтах з `eval/sites.json` (один з `en`) — у розкадровці є `motionNote` на кожній сцені й `musicNote`, українською.
- **Паралельність:** одночасно з усіма.

### B6: Чекліст підкроків у центральній панелі — п.2

- **Володіє:** `apps/api/public/static/js/views/stage-progress.js`, `apps/api/public/static/css/stage-progress.css`, `apps/api/public/static/dev/fixture-events.js`, `apps/api/public/static/dev/fixture-states.js`; тест `apps/api/test/ui/stage-progress.test.ts`.
- **Залежить від:** Крок 0 (0.2, 0.6). B2 — не обов'язково (фікстури з `step`).
- **Що зробити:**
  - Для crawling/brandkit/scripting замість `stageLog` — чекліст усіх кроків `STAGE_STEPS[status]`: ✓ виконані з тривалістю («12 с», різниця `at` сусідніх подій), спінер на поточному з лічильником done/total, якщо є, сірі майбутні; `optional` кроки — лише якщо почались.
  - Крок події: `ev.step`, інакше — перший крок, у якого `stages` містить `ev.stage`. Крок, на який перестрибнули, — ✓ (без часу).
  - directing: дві колонки за `branch` («Сцени», «Музика») з чеклістом кожної, нижче спільні `sfx` → `review` → `review-fix`.
  - rendering: рядок на кожен формат з відсотком (як зараз) — у вигляді чекліста.
  - revising: «Розбираю правку», далі кроки стадій, що реально прийшли (динамічно).
  - Загальний таймер стадії (вже є на таймлайні) не дублювати.
- **Критерії приймання:** на фікстурі scripting видно 4 кроки з правильними станами на кожному етапі; на старих фікстурах без `step` UI не порожній (кроки визначаються за `stage`); патч на місці без перебудови при новій події того самого статусу (як зараз).
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/stage-progress.test.ts`
- **Паралельність:** одночасно з усіма.

### B7: Ребрендинг на Crealab — п.3

- **Володіє:** `apps/api/public/index.html`, `apps/api/public/static/js/views/topbar.js`, `apps/api/public/static/js/views/start.js`, `apps/api/public/static/js/views/checkout.js`, `apps/api/public/static/dev/fixtures/_base.js`, `apps/api/src/routes/auth.ts` (теми й тексти листів), `apps/api/src/auth.ts` (realm), `apps/api/public/static/css/components.css` (лише якщо wordmark потребує правки під нову довжину); тести `apps/api/test/ui/topbar.test.ts`, `apps/api/test/ui/start.test.ts`, `apps/api/test/ui/checkout.test.ts`, `apps/api/test/ui/accounts-flows.test.ts`, `apps/api/test/ui/admin.test.ts`, `apps/api/test/admin.test.ts`, `apps/api/test/auth.test.ts`, `apps/api/test/auth-routes.test.ts`.
- **Залежить від:** Крок 0 (`BRAND_NAME` у contracts.js).
- **Що зробити:** скрізь, де користувач бачить «AdCreative», — `BRAND_NAME` («Crealab»): `<title>`, wordmark у шапці/старті/чекауті, листи активації й скидання пароля, realm. `ROLE_LABELS` уже зроблено в Кроці 0.
- **Критерії приймання:** `grep -rn "AdCreative" apps/api/public apps/api/src --include=*.js --include=*.ts --include=*.html` — лише CSS-коментарі; wordmark не ламає верстку шапки на 375 px.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/topbar.test.ts test/ui/start.test.ts test/ui/checkout.test.ts test/ui/accounts-flows.test.ts test/ui/admin.test.ts test/admin.test.ts test/auth.test.ts test/auth-routes.test.ts`
- **Паралельність:** одночасно з усіма.

## 4. Карта володіння файлами

| Блок | Файли |
|---|---|
| Крок 0 | `packages/shared/src/schemas/events.ts`, `schemas/storyboard.ts`, `queue.ts`, `progress-steps.ts` (нов.), `index.ts`, `events/emit.ts`, `i18n/uk.ts`; `packages/director/src/io.ts`; `packages/pipeline/src/machine.ts` (лише сигнатура `progress` і `step` у викликах); `apps/api/src/routes/projects.ts` (лише zod `CommandBody` і проброс); `apps/api/public/static/js/contracts.js`, `initial.js`, `data/reduce.js` (лише проброс `step`); тести з розділу 0 |
| B1 | `packages/pipeline/src/checkpoints.ts`, `packages/pipeline/test/checkpoints.test.ts` |
| B2 | `packages/crawler/src/stage.ts`, `packages/brandkit/src/stage.ts`, `packages/director/src/stages/{storyboard,check,review}.ts` + їхні тести |
| B3 | `public/static/js/data/actions.js`, `views/cp-brand.js`, `views/cp-board.js`, `css/cp-brand.css`, `css/cp-board.css`, `packages/pipeline/src/machine.ts`, `driver.ts`, `apps/api/src/routes/projects.ts` (обробка approve) + тести |
| B4 | `views/chat.js`, `data/reduce.js`, `css/chat.css` + тести |
| B5 | `prompts/storyboard.md`, `prompts/revise.md`, `views/cp-script.js`, `css/cp-script.css`, `dev/fixtures/workspace.js` + тести |
| B6 | `views/stage-progress.js`, `css/stage-progress.css`, `dev/fixture-events.js`, `dev/fixture-states.js` + тест |
| B7 | `public/index.html`, `views/topbar.js`, `views/start.js`, `views/checkout.js`, `dev/fixtures/_base.js`, `src/routes/auth.ts`, `src/auth.ts`, `css/components.css` + тести |

**Спільні файли й власники:** `i18n/uk.ts`, `contracts.js`, `initial.js`, схеми shared — лише Крок 0, після нього заморожені (потрібен новий ключ/тип — це зміна Кроку 0, а не блоку). `machine.ts` — Крок 0 (сигнатура), далі лише B3. `reduce.js` — Крок 0 (проброс), далі лише B4. `projects.ts` — Крок 0 (схема), далі лише B3. `chat.test.ts` — Крок 0 (ROLE_LABELS), далі лише B4. Фікстури: `workspace.js` — B5, `fixture-events/states.js` — B6, `_base.js` — B7, `fixtures/chat.js` — нікому (якщо треба — B4).

## 5. Спільні ресурси й ізоляція

- Усі тести блоків — vitest з фейковими storage/llm/redis (`test/helpers.ts`), спільна БД/Redis не потрібні.
- Ручна перевірка UI — `?mock=1` (mock-бекенд на фікстурах) на окремому порту на кожен worktree: `PORT=3101`, `3102`… через `.env.local` у worktree. Worktree не ізолює порти — не запускати два dev-сервери на одному.
- `pnpm eval` (B5) ходить у реальний LLM і пише в `eval/`-вихід — запускати лише з worktree B5, з власним `ADC_DATA_DIR`.
- Свіжий worktree: `pnpm install` перед тестами.

## 6. План інтеграції

- **Порядок злиття:** Крок 0 → хвиля 1: B1, B2, B4, B6, B7 (незалежні, будь-який порядок) → хвиля 2: B3, B5 (найбільші зміни поведінки, вливати останніми, щоб рев'ю було на свіжому main).
- **Інтеграційна гілка:** `integration/chat-interface-fixes` — туди по черзі мерджимо блоки й проганяємо команди хвилі. Після кожного merge — `git merge main` у решту відкритих гілок, щоб конфлікти спливали рано.
- **Після Кроку 0:** команди тестів з розділу 0 + `pnpm typecheck`.
- **Після хвилі 1:**
  ```
  pnpm --filter @adc/pipeline exec vitest run test/checkpoints.test.ts
  pnpm --filter @adc/crawler exec vitest run test/stage-progress.test.ts
  pnpm --filter @adc/brandkit exec vitest run test/stage.test.ts
  pnpm --filter @adc/director exec vitest run test/storyboard-progress.test.ts test/check-strip.test.ts test/review.test.ts
  pnpm --filter @adc/api exec vitest run test/ui/chat.test.ts test/ui/reduce.test.ts test/ui/stage-progress.test.ts test/ui/topbar.test.ts test/ui/start.test.ts test/ui/checkout.test.ts test/auth.test.ts test/auth-routes.test.ts
  ```
  + smoke: `?mock=1&jump=scripting` і `&jump=brand` у браузері — прогрес чеклістом, у чаті 1 рядок, шапка «Crealab».
- **Після хвилі 2:**
  ```
  pnpm --filter @adc/api exec vitest run test/ui/cp-brand.test.ts test/ui/cp-board.test.ts test/ui/actions.test.ts test/ui/cp-script.test.ts test/projects.test.ts
  pnpm --filter @adc/pipeline exec vitest run test/machine.test.ts
  pnpm --filter @adc/director exec vitest run test/storyboard-revise.test.ts
  pnpm --filter @adc/shared exec vitest run test/prompts.test.ts
  ```
  + smoke: на ЧП1 зняти 9:16, обрати 1:1 і en → у чаті нічого; «Затвердити» → рядок «Формати: 1:1 · Мова відео: англійська», на ЧП2 «Рух» українською.

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | Лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | Тести розділу 0 + `pnpm typecheck` | Ні |
| Після злиття хвилі | Команди хвилі з розділу 6 + smoke | Ні |
| Блок змінив спільний файл (лише Крок 0 має право) | Тести Кроку 0 + тести споживачів: `test/ui/contracts.test.ts`, `test/ui/reduce.test.ts`, `packages/shared/test/parity-contracts.test.ts`, `packages/pipeline/test/machine.test.ts` | Ні |
| **Фінал — усе злито** | **`pnpm test` + `pnpm typecheck` + `pnpm lint`** | **Так, один раз** |

Правила для агента (дослівно):
- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на main до змін; якщо падало — не чіпай, лише зафіксуй у звіті.»
- «Фінальний прогін — це ворота перед деплоєм: поки він не зелений, ТЗ не вважається виконаним.»
- «Не редагуй файли поза своїм рядком карти володіння. Потрібна зміна в замороженому файлі — зупинись і опиши її у звіті.»

## 8. Review і Definition of Done

**На блок:** тести блоку зелені; `pnpm biome check <змінені файли>` чистий; diff лише у власних файлах; критерії приймання перевірені (для UI-блоків — скриншот `?mock=1` у PR); старі події/розкадровки без нових полів не ламають UI.

**На ТЗ:** фінальний `pnpm test` + `pnpm typecheck` + `pnpm lint` зелені (або падіння підтверджені як наявні на main); ручний прогін одного реального проєкту від URL до ЧП3: у чаті жодної стіни тексту, прогрес чеклістом, «Crealab» у шапці, ЧП2 без англійських службових текстів, формати/мова застосовуються лише по «Затвердити».

## 9. Запуск у Claude Code

- **Просто (рекомендовано):** Крок 0 — одна сесія. Після merge — окрема сесія Desktop на кожен блок хвилі 1 (B1, B2, B4, B6, B7 — по 2–3 одночасно), далі B3 і B5. Кожна сесія отримує свій worktree автоматично.
- **CLI:** `claude -w chat-fixes-b1`, у другому терміналі `claude -w chat-fixes-b2` тощо.
- **Субагенти в одній сесії:** `isolation: worktree` у frontmatter агента або «use worktrees for your agents».
- Нагадування: `main` чистий; не більше 2–4 потоків одночасно; у свіжому worktree — `pnpm install`; після merge — `git worktree remove`.
