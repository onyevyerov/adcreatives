# ТЗ: Вартість ролика — клас A і перемикачі для A/B

## 1. Мета і контекст

Звіт `docs/analysis/cost-optimization.md` розібрав три ролики прода (2026-10-23): $11.13 / $7.36 / $11.59 проти цілі
≤ $5.5. Це ТЗ реалізує дві речі.

**1. Клас A** — зміни, що не впливають на якість (A0–A4 зі звіту, §3), очікувано ≈ −$1.1 на ролик:

| | Зміна | Ефект |
|---|---|---|
| A1 | Спільний контекст fix (бренд + код усього фільму) іде одним кешованим блоком перед картинками | −$0.57…1.43 |
| A2 | Проп `by` у `Headline`/`Body` | систематична TS2322 і зайве коло fix(check) |
| A3 | sfx не пише картинки в 5m-кеш | −$0.08 |
| A4 | storyboard без зайвого запиту з 400 | $0, мінус один запит |
| A0 | Історія рецензій і QA по колах | $0, без неї ефект кіл не виміряти |

**2. Перемикачі для майбутніх A/B**: `ADC_FIX_EFFORT`, `ADC_FIX_OUTPUT`, `ADC_REVIEW_JOIN_SIDE`. Їхній дефолт — поточна
поведінка. Перемикачі лише дають змогу ввімкнути варіанти B3, B4 і B1 зі звіту без деплою коду.

Монорепо `adcreative` (pnpm, TypeScript, vitest, biome). Зачіпає:
- `packages/shared` — Tuning, LLM-обгортка, схема рецензії, шляхи;
- `packages/director` — стадії fix, review, qa, sfx;
- `packages/motion-kit`;
- `prompts/` — code-fix, review, storyboard;
- `tests/integration` — звіт eval.

**Рішення власника (2026-10-26):**
- $5.5 — середня ціль;
- кількість кіл можна змінювати після A/B;
- перемикачі `ADC_FIX_EFFORT`, `ADC_FIX_OUTPUT`, `ADC_REVIEW_JOIN_SIDE` і історію рецензій/QA погоджено;
- бюджет A/B **не погоджено** — жодних платних прогонів у цьому ТЗ.

### Поточний стан (на що спираємось)

**Fix: порядок і кеш запиту.**
- `packages/shared/src/llm/client.ts:398-402` — вміст user-повідомлення завжди `[...images, userCached?, tail]`.
- `packages/director/src/stages/fix.ts:338` — `cacheUserPrefix: parallel && images.length === 0`. У колах qa/review
  спільний блок не кешується, бо картинки стоять перед ним. Прогрів (`fix.ts:321`) пише його в 5m-кеш даремно.

**Fix: що потрапляє в некешований хвіст.**
- Код інших сцен `readonlyScenesFor` (`fix.ts:103-120`) стоїть після `=== cache ===` (`prompts/code-fix.md:99-102`).
  Це 57–69% некешованого input fix.
- Effort fix для `reason: check` береться з `Tuning.fixCheckEffort` (`fix.ts:260`). Для qa і review — завжди
  frontmatter `high`.

**Зауваження рецензента в fix.**
- Склейку (`join`) отримують обидві сцени: `reviewIssuesFor` (`fix.ts:126-132`), тексти — `reviewLine`
  (`fix.ts:135-150`), маршрут — `routesOf` (`packages/director/src/stages/review.ts:244`).
- `review.json` перезаписується кожним колом (`review.ts:382`).
- `qa.json` перезаписується кожним запуском qa.

**motion-kit.** `Headline`/`Body` (`packages/motion-kit/src/text/components.tsx:61-75, 90-103`) не оголошують `by`.
`TextBlock` його підтримує (`TextBlock.tsx:40`), пропи прокидаються через `{...props}`. `API.md:51` і
`prompts/codegen.md:123` радять `by="line"`.

**sfx.** У `prompts/sfx-design.md:78` рядок `=== cache ===` стоїть після картинок і розкадровки. Кеш читає лише ретрай за
лімітами (`sfx.ts:551-581`).

**storyboard.** Немає `schema_mode: prompt`. Перший виклик у кожному процесі отримує 400 «grammar too large»
(`client.ts:283-288, 465-470`). Мітка `promptOnlySchemas` живе лише в пам'яті процесу.

### Поза скоупом

- Варіанти зі звіту, не погоджені до коду:
  - B-M — злиття другого кола QA з колом рецензії (`ADC_SECOND_PASS`);
  - B5 — дешевий ремонт TS-помилок;
  - B6 — effort codegen;
  - B7 — sfx на Sonnet;
  - B8 — менші стрічки.
- B2 і Q1 вмикаються наявними `ADC_REVIEW_MAX_ROUNDS` і `ADC_QA_MAX_ROUNDS` — коду не треба.
- Будь-які живі прогони: `LIVE=1`, `pnpm eval` з ключами. Їх запускає лише власник, і бюджет ще не погоджено.
- `--from fix` в eval.
- Зміна дефолтів моделей і effort.

### Поведінка за замовчуванням після ТЗ

Свідомі зміни дефолту:

| Звідки | Що змінюється |
|---|---|
| A1 | Розкладка повідомлення code-fix |
| A2 | Код з `by` компілюється |
| A3 | sfx без user-кешу |
| A4 | storyboard зі схемою в промпті з першого виклику |
| A0 | Додаткові файли історії |
| Крок 0.3 | Рецензент заповнює нове поле `fixSceneId` — один рядок у `prompts/review.md`. Свідомо однаково в обох режимах `ADC_REVIEW_JOIN_SIDE`, щоб гілки A/B відрізнялись лише маршрутом |
| Блок 5 | Текст формату відповіді fix переїжджає з system у хвіст повідомлення, у режимі `file` дослівно той самий |

**Усе інше — байт у байт як зараз.**

## 2. Крок 0 — заморожені інтерфейси (окремий PR, робиться першим)

Поки Крок 0 не влито в `main`, блоки не стартують. Усі зміни адитивні: старі `review.json`, `qa.json`, `pipeline.json` і
env без нових змінних мають читатися як раніше. Крок 0 не змінює поведінку: нові поля мають дефолти поточної поведінки.
Виняток — 0.3: рецензент починає заповнювати `fixSceneId`, але код це поле ще ніде не читає.

### 0.1 Перемикачі — `packages/shared/src/tuning.ts`

```ts
  /** Effort fix для reason qa/review; null — frontmatter `code-fix.md`. Для `check` — як і раніше `fixCheckEffort`. */
  fixEffort: Effort.nullable().default(null),
  /** file — fix повертає повний файл сцени (як зараз); patch — блоки правок `<edits>` (Блок 5). */
  fixOutput: z.enum(["file", "patch"]).default("file"),
  /** both — join-зауваження рецензента правлять обидві сцени (як зараз); one — лише сцену `fixSceneId`. */
  reviewJoinSide: z.enum(["both", "one"]).default("both"),
```

У `TUNING_ENV` додати:
- `fixEffort: "ADC_FIX_EFFORT"`;
- `fixOutput: "ADC_FIX_OUTPUT"`;
- `reviewJoinSide: "ADC_REVIEW_JOIN_SIDE"`.

Невалідне значення — `TuningError`, як для решти.

У `README.md` додати рядки таблиць із посиланням на `docs/analysis/cost-optimization.md`:
- у «Перемикачі генерації» — `ADC_FIX_EFFORT`, `ADC_FIX_OUTPUT`;
- у «Звукорежисер і рецензент фільму» — `ADC_REVIEW_JOIN_SIDE`.

### 0.2 Порядок картинок — `packages/shared/src/llm/client.ts`

```ts
export interface LlmCallOptions {
  …
  /**
   * true — зображення йдуть ПІСЛЯ блоку userCached (між ним і хвостом), щоб спільний userCached кешувався у
   * паралельних викликах із різними картинками. Дефолт false — зображення першими (як зараз). Без userCached
   * ігнорується.
   */
  imagesAfterCache?: boolean;
}
```

- У `buildParams`:
  - якщо `imagesAfterCache && cachedBlock` — вміст `[cachedBlock, ...images, tail]`;
  - інакше — як зараз.
- `warm()` без змін. Його вміст `[cachedBlock]` — префікс таких викликів, тож прогрів читається.

### 0.3 Схема рецензії — `packages/shared/src/schemas/review.ts` + `prompts/review.md`

```ts
export const ReviewIssue = z.object({
  …
  /** Для scope join — сцена, чий код змінює `fix` (sceneId або nextSceneId); scene/film — null. */
  fixSceneId: z.string().nullable().default(null),
});

export const FilmReview = FilmReviewDraft.extend({
  …
  /** Режим маршруту склейок, з яким рахувались routes (Tuning.reviewJoinSide на момент рецензії). */
  joinSide: z.enum(["both", "one"]).default("both"),
});
```

У `prompts/review.md`, розділ «# Remarks»:

1. Після пункту `sceneId` додати:

   > - `fixSceneId`: for `join` — the one scene whose code your `fix` changes (`sceneId` or `nextSceneId`); the
   >   other side keeps its edge as it is; `null` for `scene` and `film`.

2. Речення про склейку в пункті `fix` замінити на:

   > For a join: what must change in the scene named in `fixSceneId` so that the last state of the scene before
   > the cut is the first state of the next.

### 0.4 Шляхи історії — `packages/shared/src/storage/paths.ts` (`revPaths`)

```ts
    /** Знімок qa.json після запуску qa з цим attempt (A0). */
    qaHistory: (attempt: number) => join(root, "history", `qa-a${attempt}.json`),
    /** Знімок review.json після кола рецензії (A0). */
    reviewHistory: (round: number) => join(root, "history", `review-r${round}.json`),
```

### 0.5 Хелпери зауважень рецензента — новий `packages/director/src/review-issues.ts`

Перенести з `fix.ts` **без зміни поведінки**:

```ts
export type ReviewForFix = Pick<FilmReview, "issues"> & { joinSide?: FilmReview["joinSide"] };

/** Зауваження рецензента для сцени: маршрут fix; для join — як зараз обидві сторони (режим one — Блок 3). */
export function reviewIssuesFor(review: ReviewForFix | null, sceneId: string): ReviewIssue[];

/** Рядок зауваження для `<problems>`; joinSide undefined = "both". */
export function reviewLine(i: ReviewIssue, sceneId: string, joinSide?: FilmReview["joinSide"]): string;

/** Блок «Film reviewer's remarks…» для describeProblems: заголовок + рядки; [] — зауважень немає. */
export function reviewProblemLines(review: ReviewForFix | null, sceneId: string): string[];
```

Зміни у `fix.ts`:
- `describeProblems` замість власного циклу викликає `lines.push(...reviewProblemLines(args.review ?? null, sceneId))`;
- реекспорт для сумісності: `export { reviewIssuesFor } from "../review-issues.ts"`.

Більше Крок 0 у `fix.ts` нічого не чіпає.

### 0.6 Контракти без коду (фіксуються тут, реалізують блоки)

**Модуль патчів `packages/director/src/patch.ts`** (Блок 4, споживач — Блок 5):

```ts
export interface SceneEdit { old: string; new: string }
export type ParsedFixOutput =
  | { kind: "edits"; edits: SceneEdit[] }
  | { kind: "file"; code: string }   // модель повернула повний `<file name="sN.tsx">`
  | { kind: "none" };
export function parseFixOutput(text: string, sceneId: string): ParsedFixOutput;
export function applyEdits(code: string, edits: readonly SceneEdit[]):
  | { ok: true; code: string }
  | { ok: false; reason: string; editIndex: number };
/** Текст `<output_format>` для режиму file: дослівно нинішній `code-fix.md` «# Output format» + «return its full code». */
export function fileOutputFormat(sceneId: string): string;
/** Текст `<output_format>` для режиму patch: блоки `<edits>`, правила `old`, коли повертати повний файл. */
export function patchOutputFormat(sceneId: string): string;
```

**Формат патча:**

```
<edits file="sN.tsx">
<edit>
<old>
…рядки поточного коду дослівно…
</old>
<new>
…заміна (може бути порожньою)…
</new>
</edit>
…
</edits>
```

Правила застосування:
- CRLF нормалізується;
- усередині `old` і `new` знімається рівно один перший і один останній перенос рядка;
- кожен `old` непорожній і трапляється в поточному (уже частково зміненому) коді рівно один раз;
- правки застосовуються по черзі.

Модель може замість `<edits>` повернути повний `<file name="sN.tsx">` — цього вимагає `patchOutputFormat`, коли
змінюється більше половини файлу.

**Змінні `prompts/code-fix.md`:**
- `filmScenes` (Блок 1) замінює `readonlyScenes`;
- `outputFormat` (Блок 5) — нова.

**`costDetail` викликів fix:**
- `warm` і `scene:<id>` — без змін;
- запасний виклик після невдалого патча — `scene:<id>:file-fallback` (Блок 5; лічить Блок 6).

### 0.7 Компіляція споживачів

Тести входять у `tsc` (`include: ["src", "test", …]`). Крок 0 додає `fixSceneId: null` і `joinSide: "both"` у
типізовані літерали `ReviewIssue`/`FilmReview` — **лише ці поля, нічого більше**. Файли:
- `packages/director/test/fix-review.test.ts`, `review.test.ts`, `sfx.test.ts`;
- `packages/pipeline/test/checkpoints.test.ts`, `machine.test.ts`;
- `packages/shared/test/review.test.ts`;
- `tests/integration/test/eval.test.ts`.

У `packages/shared/test/prompts.test.ts` у рендер `code-fix` додати змінні `filmScenes: "-"` і `outputFormat: "-"`.
Зайві змінні рендер ігнорує, тож тест зелений і до, і після Блоків 1 та 5.

### Тести Кроку 0

```bash
pnpm --filter @adc/shared exec vitest run test/tuning.test.ts test/llm.test.ts test/review.test.ts test/storage.test.ts test/prompts.test.ts
```

```bash
pnpm --filter @adc/director exec vitest run test/fix-review.test.ts test/review.test.ts test/sfx.test.ts
```

```bash
pnpm --filter @adc/pipeline exec vitest run test/checkpoints.test.ts test/machine.test.ts
```

```bash
pnpm --filter @adc/integration exec vitest run test/eval.test.ts
```

```bash
pnpm typecheck
```

Нові тести Кроку 0:
- дефолти й валідація трьох перемикачів;
- порядок `[cachedBlock, ...images, tail]` при `imagesAfterCache` і незмінний порядок без нього; перший блок вмісту
  виклику збігається з блоком прогріву;
- старий `review.json` без нових полів читається з `fixSceneId: null`, `joinSide: "both"`;
- шляхи історії.

## 3. Блоки робіт

### Блок 1: fix — спільний контекст у кеші (A1) і `ADC_FIX_EFFORT`

- **Володіє:**
  - `packages/director/src/stages/fix.ts`, `prompts/code-fix.md`;
  - `packages/director/test/fix-images.test.ts`, `fix-review.test.ts`, `check-fix.test.ts`.
- **Залежить від:** Крок 0 (0.1 `fixEffort`, 0.2 `imagesAfterCache`, 0.5 `review-issues.ts`, 0.6 назва `filmScenes`).
- **Що зробити:**
  1. **`filmScenesFor(...)`** замість `readonlyScenesFor`. Це блоки `<file name="sN.tsx">` **усіх** сцен у порядку
     розкадровки, включно зі своєю. Без шаблонних сцен і без тих, чия поточна версія відхилена guard'ом.
     - Рахувати **один раз** на запуск стадії, до `prepare`, щоб текст був байт-однаковий у всіх викликах кола.
     - `code` у змінних: коли своя сцена є у film-блоці — `(the current code of this scene is the file sN.tsx in
       <film>)`; інакше як зараз — код відхиленої версії або «(no code…)».
  2. **`prompts/code-fix.md`, user-частина:** блок `<film>\n{{filmScenes}}\n</film>` іде одразу після рядка
     «Reason for the fix…», **над** `=== cache ===`. Під `=== cache ===` лишаються `<scene>`, `<code>`, `<problems>`
     і фінальний рядок.
  3. **System-частина `code-fix.md`:**
     - згадки `<readonly_scenes>` (рядки 12, 16, 21, 23, 66, 71) → `<film>` зі змістом «код усіх сцен фільму, і твоєї
       теж; змінюй лише свою, не повертай інші»;
     - «as images before the text of the message» → «as images after the film's code, before your scene and its
       problems».
     - Розділ «# Output format» не чіпати — його переносить Блок 5.
  4. **`fixOne`:** `imagesAfterCache: true` завжди; `cacheUserPrefix: parallel`, незалежно від картинок. Прогрів без
     змін, з тим самим `first.vars`.
  5. **Effort:** `reason === "check" ? tuning.fixCheckEffort : tuning.fixEffort` (null → frontmatter), однаковий у
     прогріві й викликах.
- **Критерії приймання** (на моках `createMockAnthropic`):
  - **Коло qa з двома і більше цілями.** У кожного виклику `messages[0].content` = `[text(film-блок, cache_control
    5m), image…, text(хвіст)]`. `content[0].text` прогріву дорівнює `content[0].text` кожного виклику. `system`,
    `model` і effort однакові. Film-блок містить код своєї сцени й сусідів і не містить шаблонних і відхилених.
  - **Коло check з двома і більше цілями:** те саме без картинок.
  - **Одна ціль:** без прогріву, без `cache_control` на film-блоці, картинки після нього.
  - **`ADC_FIX_EFFORT=medium`** (через `deps.tuning`): qa і review беруть medium у прогріві й викликах; check —
    `fixCheckEffort`; null — `high` з frontmatter.
  - `costDetail` (`warm`, `scene:<id>`) і `outputs` стадії — без змін.
  - Очікуваний ефект на проді: у викликах `scene:*` input ≈ 5–9k, `cacheRead` ≈ 70.5k + код фільму. Перевіряється
    по `costs.jsonl` першого ролика після деплою, без окремих прогонів.
- **Тести:**
  ```bash
  pnpm --filter @adc/director exec vitest run test/fix-images.test.ts test/fix-review.test.ts test/check-fix.test.ts
  ```
  ```bash
  pnpm --filter @adc/shared exec vitest run test/prompts.test.ts
  ```
  Тест `prompts.test.ts` — лише запуск, файл не редагувати.
- **Паралельність:** хвиля 1, одночасно з Блоками 2, 3, 4.

### Блок 2: motion-kit — `by` у `Headline` і `Body` (A2)

- **Володіє:**
  - `packages/motion-kit/src/text/components.tsx`;
  - `packages/motion-kit/API.generated.md` — лише регенерація командою `pnpm --filter @adc/motion-kit docs`;
  - новий `packages/motion-kit/test/text-props.test.tsx`;
  - `packages/director/test/typecheck.test.ts`.
- **Залежить від:** нічого, крім `main` після Кроку 0.
- **Що зробити:**
  - Додати `by?: "word" | "line"` (JSDoc: «Дефолт "word"; "line" — швидка поява довгого тексту») у пропи `Headline`
    і `Body`. Проп уже прокидається в `TextBlock` через `{...props}`.
  - Регенерувати `API.generated.md`. `API.md` не міняти — `by` там уже описано.
- **Критерії приймання:**
  - сцена з `<Headline by="line" preset="rise" …/>` і `<Body by="line" …/>` проходить `typecheckScenes`, як у стадії
    check;
  - рендер з `by="line"` дає елементи по рядках, як `TextBlock`;
  - без `by` — як зараз.
  - Нова версія `API.generated.md` змінить хеш префікса `motion-reference`. Після деплою один раз запишеться 1h-кеш,
    ≈ $0.6 — це очікувано.
- **Тести:**
  ```bash
  pnpm --filter @adc/motion-kit exec vitest run test/text-props.test.tsx test/examples.test.ts
  ```
  ```bash
  pnpm --filter @adc/director exec vitest run test/typecheck.test.ts
  ```
- **Паралельність:** хвиля 1.

### Блок 3: рецензія — історія кіл (A0) і `ADC_REVIEW_JOIN_SIDE`

- **Володіє:**
  - `packages/director/src/stages/review.ts`, `packages/director/src/review-issues.ts`;
  - `packages/director/test/review.test.ts`, новий `packages/director/test/review-join-side.test.ts`.
- **Залежить від:** Крок 0 (0.1 `reviewJoinSide`, 0.3 схема, 0.4 `reviewHistory`, 0.5).
- **Що зробити:**
  1. `ReviewStageDeps` = `{ tuning?: () => Tuning }`, дефолт — `readTuning()` на кожен запуск, як у fix.
  2. **`sanitizeIssues`:**
     - для `join` поле `fixSceneId` має дорівнювати `sceneId` або нормалізованому `nextSceneId`;
     - якщо названа сторона — шаблонна сцена, береться інша сторона;
     - будь-яке інше значення → `null`;
     - для `scene` і `film` → `null`.
  3. **`routesOf(sb, issues, templates, joinSide)`:**
     - `one` + `fixSceneId` → у fix іде лише ця сцена;
     - `fixSceneId: null` або режим `both` → обидві сторони, як зараз.
  4. У `FilmReview` писати `joinSide = tuning.reviewJoinSide`; `joinSide` входить в `inputsHash`, щоб рецензію не
     перевикористати між режимами.
  5. **A0:** кожен запис `rp.review`, і свіжий, і перевикористаний (`review.ts:338, 382`), дублювати в
     `rp.reviewHistory(round)`.
  6. **`review-issues.ts`, режим `one`:**
     - join-зауваження отримує сцена `fixSceneId` — з рядком, як зараз для її боку;
     - друга сторона, якщо вона в fix з інших причин, отримує рядок «- [<severity>, join] At the cut with <sX> the
       other scene is changed to match you: keep your first/last frames exactly as they are.»;
     - `both` — поведінка Кроку 0.
- **Критерії приймання:**
  - **Режим `both`:** маршрути й тексти `<problems>` байт у байт як зараз; `test/fix-review.test.ts` зелений без
    змін.
  - **Режим `one`:** join s2→s3 з `fixSceneId: "s3"` → `routes.fix` має s3 і не має s2 (якщо в s2 немає інших
    major/critical). У s2, коли вона в fix з іншої причини, є рядок «keep your … frames».
  - `history/review-r0.json` і `review-r1.json` лежать після двох кіл; перевикористана рецензія теж пише історію.
  - Старий `review.json` читається як `both`.
- **Тести:**
  ```bash
  pnpm --filter @adc/director exec vitest run test/review.test.ts test/review-join-side.test.ts test/fix-review.test.ts
  ```
  Тест `fix-review.test.ts` — лише запуск, файл належить Блоку 1.
- **Паралельність:** хвиля 1.

### Блок 4: модуль патчів (основа `ADC_FIX_OUTPUT=patch`)

- **Володіє:** новий `packages/director/src/patch.ts`, новий `packages/director/test/patch.test.ts`.
- **Залежить від:** контракт 0.6. Нікуди не підключається.
- **Що зробити:**
  - реалізувати `parseFixOutput`, `applyEdits`, `fileOutputFormat`, `patchOutputFormat` за 0.6;
  - текст `fileOutputFormat` — дослівно нинішній «# Output format» з `code-fix.md:74-76` плюс «Repair scene sN and
    return its full code in `<file name="sN.tsx">`».
- **Критерії приймання:** тести покривають:
  - валідні правки, застосовані по черзі;
  - видалення (порожній `new`);
  - `old`, якого немає, і `old`, що трапляється двічі → `ok: false` з `editIndex`;
  - порожній `old`;
  - CRLF;
  - повний `<file>` замість `<edits>` → `kind: "file"`;
  - сміття → `kind: "none"`;
  - чужий `file="sX.tsx"` → `none`.
- **Тести:**
  ```bash
  pnpm --filter @adc/director exec vitest run test/patch.test.ts
  ```
- **Паралельність:** хвиля 1.

### Блок 5: fix — режим патчів `ADC_FIX_OUTPUT` (хвиля 2, після Блоків 1 і 4)

- **Володіє:**
  - `packages/director/src/stages/fix.ts`, `prompts/code-fix.md`, новий `packages/director/test/fix-patch.test.ts`;
  - право оновити `fix-images.test.ts`, `fix-review.test.ts`, `check-fix.test.ts`, якщо перенос формату ламає їхні
    асерти. Блок 1 на той момент уже влито.
- **Залежить від:** Блок 1 (влитий), Блок 4 (влитий), Крок 0 (0.1 `fixOutput`).
- **Що зробити:**
  1. **`code-fix.md`:**
     - розділ «# Output format» → «Return exactly what `<output_format>` at the end of the message asks for, with no
       markdown fences and no explanations.»;
     - останній рядок user-частини → `Repair scene {{sceneId}}.\n\n<output_format>\n{{outputFormat}}\n</output_format>`.

     System однаковий в обох режимах, тож кеш спільний.
  2. **`fix.ts`:** `outputFormat = tuning.fixOutput === "patch" && <є поточний код> ? patchOutputFormat(id) :
     fileOutputFormat(id)`. Режим фіксується на запуск стадії.
  3. **Розбір відповіді:** `parseFixOutput`.
     - `edits` → `applyEdits(поточний код)`; `ok` → код.
     - `file` → код.
     - Інакше — **один** запасний виклик з тими самими змінними, але `outputFormat = fileOutputFormat(id)`: ті самі
       картинки, effort і `cacheUserPrefix`, `costDetail: "scene:<id>:file-fallback"`. Далі `parseSingleScene`.
     - Сирі відповіді обох викликів писати в `director/raw`.
     - Далі guard і версія — як зараз.
- **Критерії приймання:**
  - **`file`:** хвіст містить `fileOutputFormat`; поведінка і `costDetail` як після Блоку 1. Film-блок (`content[0]`)
    однаковий у режимах `file` і `patch`.
  - **`patch`:** валідний патч → нова версія з застосованим кодом через guard. Патч, що не застосувався, → рівно один
    виклик `scene:<id>:file-fallback`, і він читає той самий film-блок. Сцена без коду → одразу формат `file`.
- **Тести:**
  ```bash
  pnpm --filter @adc/director exec vitest run test/fix-patch.test.ts test/patch.test.ts test/fix-images.test.ts test/fix-review.test.ts test/check-fix.test.ts
  ```
  ```bash
  pnpm --filter @adc/shared exec vitest run test/prompts.test.ts
  ```
- **Паралельність:** хвиля 2, одночасно з Блоками 6 і 7.

### Блок 6: історія QA (A0) і звіт eval для A/B (хвиля 2)

- **Володіє:**
  - `packages/director/src/stages/qa.ts`, `packages/director/test/qa.test.ts`;
  - `tests/integration/src/eval.ts`, `tests/integration/test/eval.test.ts`;
  - `eval/README.md`.
- **Залежить від:** Крок 0 (0.4, 0.6 `costDetail`). Читає файли історії за шляхами 0.4. У тестах — фікстури, тож
  від Блоку 3 не залежить.
- **Що зробити:**
  1. **`qa.ts`:** кожен запис `rp.qa` — перевикористаний (`qa.ts:405`) і свіжий (`qa.ts:476`) — дублювати в
     `rp.qaHistory(ctx.attempt)`.
  2. **`eval.ts`, звіт сайту й кейсу** (`report.json` / `report.md`):
     - **Рецензія по колах:** `review.rounds[]` = `{ round, score, verdict, major, critical, joinBreaks }` з
       `history/review-r*.json`. Немає історії — один елемент з `review.json`.
     - **QA по запусках:** `qa.rounds[]` = `{ attempt, verdict, serious, minor }` з `history/qa-a*.json`.
     - **Fix:** `{ calls, fileFallbacks, input, cacheRead, output }` з витрат прогону стадії fix (`scene:*` і
       `scene:*:file-fallback`).
     - **Перемикачі в заголовку звіту:** `ADC_FIX_EFFORT`, `ADC_FIX_OUTPUT`, `ADC_REVIEW_JOIN_SIDE` — як зараз
       `ADC_SFX_MODE`.
     - **`report.md`:** колонка «score по колах» («6 → 7») у таблиці «Звук і рецензія» і невелика таблиця «Fix».
  3. **`eval/README.md`:** нові поля й файли історії.
- **Критерії приймання:**
  - після двох запусків qa є `history/qa-a1.json` і `qa-a2.json`;
  - звіт показує score обох кіл і лічильники fix;
  - старі прогони без історії → один елемент і «—», без падіння.
- **Тести:**
  ```bash
  pnpm --filter @adc/director exec vitest run test/qa.test.ts
  ```
  ```bash
  pnpm --filter @adc/integration exec vitest run test/eval.test.ts
  ```
- **Паралельність:** хвиля 2.

### Блок 7: дрібні правки кешу — sfx (A3) і storyboard (A4) (хвиля 2)

- **Володіє:**
  - `packages/director/src/stages/sfx.ts`, `packages/director/test/sfx.test.ts`;
  - `prompts/storyboard.md` — лише frontmatter;
  - новий `packages/director/test/storyboard-schema-mode.test.ts`.
- **Залежить від:** нічого, крім `main` після Кроку 0.
- **Що зробити:**
  - **sfx:** у `call()` (`sfx.ts:551`) додати `cacheUserPrefix: false` — і для першого виклику, і для ретраю.
  - **storyboard:** у frontmatter `prompts/storyboard.md` додати `schema_mode: prompt`.
- **Критерії приймання:**
  - **sfx:** жоден user-блок не має `cache_control`; system-блок має, як зараз; ретрай за лімітами працює як раніше.
  - **storyboard:** перший виклик у свіжому процесі йде без `output_config.format`, схема в тексті
    (`schemaInPromptNote`). На успішну відповідь — рівно один виклик API. Валідаційний повтор — як був.
- **Тести:**
  ```bash
  pnpm --filter @adc/director exec vitest run test/sfx.test.ts test/storyboard-schema-mode.test.ts test/storyboard-copyfix.test.ts test/storyboard-notes.test.ts test/storyboard-progress.test.ts test/storyboard-revise.test.ts
  ```
- **Паралельність:** хвиля 2. Може йти й у хвилі 1, якщо там вільний потік: спільних файлів немає.

## 4. Карта володіння файлами

| Власник | Файли |
|---|---|
| **Крок 0** | `packages/shared/src/tuning.ts`, `src/llm/client.ts`, `src/schemas/review.ts`, `src/storage/paths.ts` і їхні тести (`tuning`, `llm`, `review`, `storage`, `prompts`) |
| Крок 0 | `prompts/review.md`, `README.md` |
| Крок 0 | `packages/director/src/review-issues.ts` (новий; далі — Блок 3); у `packages/director/src/stages/fix.ts` — лише імпорт і реекспорт |
| Крок 0 | Літерали з 0.7: `fixSceneId: null`, `joinSide: "both"` — і нічого більше |
| **Блок 1** | `packages/director/src/stages/fix.ts`, `prompts/code-fix.md`, `packages/director/test/fix-images.test.ts`, `fix-review.test.ts`, `check-fix.test.ts` |
| **Блок 2** | `packages/motion-kit/src/text/components.tsx`, `packages/motion-kit/API.generated.md` (регенерація), `packages/motion-kit/test/text-props.test.tsx`, `packages/director/test/typecheck.test.ts` |
| **Блок 3** | `packages/director/src/stages/review.ts`, `packages/director/src/review-issues.ts`, `packages/director/test/review.test.ts`, `review-join-side.test.ts` |
| **Блок 4** | `packages/director/src/patch.ts`, `packages/director/test/patch.test.ts` |
| **Блок 5** | Файли Блоку 1 після його злиття + `packages/director/test/fix-patch.test.ts` |
| **Блок 6** | `packages/director/src/stages/qa.ts`, `packages/director/test/qa.test.ts`, `tests/integration/src/eval.ts`, `tests/integration/test/eval.test.ts`, `eval/README.md` |
| **Блок 7** | `packages/director/src/stages/sfx.ts`, `packages/director/test/sfx.test.ts`, `prompts/storyboard.md` (frontmatter), `packages/director/test/storyboard-schema-mode.test.ts` |

Спільні файли — один власник на хвилю:

| Файл | Хвиля 1 | Хвиля 2 |
|---|---|---|
| `fix.ts`, `code-fix.md` | Блок 1 | Блок 5 |
| `fix-review.test.ts` | Блок 1 (Блок 3 лише запускає) | — |
| `packages/shared/**`, `README.md`, `prompts/review.md` | лише Крок 0 | лише Крок 0 |

Потрібна зміна в замороженому файлі — зупинитися й описати у звіті, не правити.

## 5. Спільні ресурси й ізоляція

- **БД немає.** Тести пишуть у тимчасові `LocalStorage` (temp dirs). Redis і черги в тестах цих блоків не
  потрібні, порти не займаються.
- **Мережа й гроші.**
  - Усі виклики моделі — через `createMockAnthropic`.
  - `ANTHROPIC_API_KEY` і `ELEVENLABS_API_KEY` у тестовому оточенні не потрібні; `.env` з ключами в worktree не
    копіювати.
  - **Заборонено:** `LIVE=1 …`, `pnpm eval` з ключами, `pnpm sfx-cache`.
- **Дані.** `DATA_DIR` (дефолт `.data`) рахується від кореня worktree — кожен worktree має своє. Чужі `.data` не
  чіпати.
- **Нагадування:** worktree ізолює файли, але не env і не запущені сервіси. Якщо локально запущено воркер, він читає
  `ADC_*` зі свого `.env` — тести на нього не покладаються.

## 6. План інтеграції

**Порядок злиття:**
1. Крок 0.
2. Хвиля 1: Блоки 1, 2, 3, 4 — незалежні, у будь-якому порядку.
3. Хвиля 2:
   - Блок 5 — після 1 і 4;
   - Блоки 6, 7 — незалежні.
4. Фінал.

**Інтеграційна гілка:** `integration/cost-class-a`. Туди по черзі мерджимо блоки й проганяємо команди хвилі. Після
кожного merge — `git merge main` (або гілки інтеграції) у решту відкритих гілок, щоб конфлікти спливали рано.

**Після Кроку 0:** команди розділу «Тести Кроку 0» (вони вже включають `pnpm typecheck`).

**Після хвилі 1:**

```bash
pnpm --filter @adc/director exec vitest run test/fix-images.test.ts test/fix-review.test.ts test/check-fix.test.ts test/review.test.ts test/review-join-side.test.ts test/patch.test.ts test/typecheck.test.ts
```

```bash
pnpm --filter @adc/motion-kit exec vitest run test/text-props.test.tsx test/examples.test.ts
```

```bash
pnpm --filter @adc/shared exec vitest run test/prompts.test.ts
```

Плюс smoke:

```bash
pnpm smoke
```

Це 2-с ролик з `TemplateScene`, без API.

**Після хвилі 2:**

```bash
pnpm --filter @adc/director exec vitest run test/fix-patch.test.ts test/fix-images.test.ts test/fix-review.test.ts test/check-fix.test.ts test/qa.test.ts test/sfx.test.ts test/storyboard-schema-mode.test.ts test/storyboard-copyfix.test.ts test/storyboard-notes.test.ts test/storyboard-progress.test.ts test/storyboard-revise.test.ts
```

```bash
pnpm --filter @adc/integration exec vitest run test/eval.test.ts
```

```bash
pnpm --filter @adc/shared exec vitest run test/prompts.test.ts
```

Плюс `pnpm smoke`.

**Фінальний крок інтегратора:** у `README.md`, розділ «Промпти → Кеш і довідка», додати один рядок: code-fix кешує
бренд і код фільму блоком перед картинками; історія рецензій і QA лежить у `rev/<n>/history/`. Це єдина правка
`README.md` поза Кроком 0.

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | Лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | «Тести Кроку 0» (зі споживачами 0.7 і `pnpm typecheck`) | Ні |
| Після злиття хвилі | Команди хвилі з розділу 6 + `pnpm smoke` | Ні |
| Блок змінив спільний файл (право має лише Крок 0) | Тести Кроку 0 + споживачі: `packages/director/test/fix-review.test.ts`, `review.test.ts`, `sfx.test.ts`, `packages/pipeline/test/checkpoints.test.ts`, `machine.test.ts`, `tests/integration/test/eval.test.ts` | Ні |
| **Фінал — усе злито** | **`pnpm test` + `pnpm typecheck` + `pnpm lint`** | **Так, один раз** |

Правила для агента (дослівно):
- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на main до змін; якщо
  падало — не чіпай, лише зафіксуй у звіті.»
- «Фінальний прогін — це ворота перед деплоєм: поки він не зелений, ТЗ не вважається виконаним.»
- «Не редагуй файли поза своїм рядком карти володіння. Потрібна зміна в замороженому файлі — зупинись і опиши її у
  звіті.»
- «Не запускай живих прогонів (`LIVE=1`, `pnpm eval` з ключами, `pnpm sfx-cache`): усі виклики моделі — через моки.»

## 8. Review і Definition of Done

**На блок:**
- тести блоку зелені;
- `pnpm biome check <змінені файли>` чистий;
- diff лише у власних файлах;
- критерії приймання перевірені тестами;
- з дефолтними `ADC_*` поведінка змінилася лише в пунктах «Поведінка за замовчуванням» розділу 1;
- у PR — до/після форми запиту з тесту (`messages[0].content` типами блоків) для Блоків 1, 5, 7.

**На ТЗ:**
- фінальний `pnpm test` + `pnpm typecheck` + `pnpm lint` зелені (або падіння підтверджені як наявні на main);
- три перемикачі описані в `README.md`;
- `docs/analysis/cost-optimization.md` §5 можна виконати без додаткового коду для B1, B3, B4.

Живі прогони не входять у DoD. Перевірка кешу A1 — за `costs.jsonl` першого прод-ролика після деплою (критерій
Блоку 1). A/B — окремо, після погодження бюджету.

## 9. Запуск у Claude Code

- **Просто (рекомендовано):**
  - Крок 0 — одна сесія.
  - Після merge — окрема сесія Desktop на кожен блок хвилі 1 (Блоки 1–4; 2–4 одночасно).
  - Далі хвиля 2: Блок 5 — коли влиті 1 і 4; Блоки 6 і 7 — одразу.
  - Кожна сесія отримує свій worktree автоматично.
- **CLI:** `claude -w cost-a-k0`, потім `claude -w cost-a-b1`, `claude -w cost-a-b2` тощо в окремих терміналах.
- **Субагенти в одній сесії:** `isolation: worktree` у frontmatter агента або «use worktrees for your agents».
- **Нагадування:**
  - `main` чистий;
  - не більше 2–4 потоків одночасно;
  - у свіжому worktree — `pnpm install`;
  - після merge — `git worktree remove`.
