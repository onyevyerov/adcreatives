# ТЗ: звукорежисер (SFX по готовій картинці) і рецензент фільму

Дата: 2026-10-15. Формат — parallel-ready: Крок 0 заморожує схеми, реєстр стадій, шляхи артефактів і
перемикачі, далі блоки без спільних файлів. Рішення власника (2026-10-15): звукорежисер — Opus 5.5
`medium`, рецензент — Opus 5.5 `high`; темп і музична лінія лишаються в розкадровці; нинішній звук
роликів оцінено як незадовільний, тому на поточну розстановку SFX як на еталон не спираємось.
Передумова: розширена бібліотека SFX (30 cue × 5, PR #27–#30) уже в `main`; кеш семплів прогрітий
власником (`LIVE=1 pnpm sfx-cache`).

## 1. Мета і контекст

Сьогодні всю творчу частину ролика робить один виклик стадії `storyboard`
(`packages/director/src/stages/storyboard.ts`): концепт, сцени, тексти, моменти на точних кадрах і
звук кожного моменту, музичний бриф. Звук призначається наосліп — до того, як існує хоч один кадр.
Далі `codegen` пише код, `check` рендерить стрічки, `qa` дивиться сцену за сценою, а стадія `audio`
паралельно генерує трек і зводить саундтрек за `events[].sound` із розкадровки
(`packages/audio/src/stage.ts`, `renderSoundtrack` у `mixer.ts`). Ніхто не дивиться на фільм цілком і
ніхто не ставить звук на те, що реально намальовано.

Це ТЗ додає дві стадії:

- **`sfx` — звукорежисер.** Після того, як відеогілка готова (check ↔ fix, qa), дивиться стрічки сцен
  і аркуші моментів (кадри ±2 навколо кожної події і кожної склейки) і вирішує, який cue і акцент
  звучить на кожній події розкадровки, або що подія мовчить. Пише `rev/<n>/sfx-plan.json`. Звук із
  розкадровки лишається чернеткою й задумом режисера — звукорежисер бачить його, але не зобов'язаний
  зберігати.
- **`review` — рецензент фільму.** Після зведення дивиться весь ролик по порядку: стрічки всіх сцен,
  аркуші моментів, звукову відомість із вимірів (кожна подія: cue, кадр, зсув до найближчої долі,
  рівень; старти сцен проти тактів; гучність по секундах) і розкадровку. Повертає структуровані
  зауваження зі сценою, кадром, типом і точною інструкцією. Код (не модель) маршрутизує їх:
  візуальні → `fix`, звукові → `sfx`, музичні → лише попередження на чекпоінті 3. Не більше
  `ADC_REVIEW_MAX_ROUNDS` кіл (дефолт 1).

Стадія `audio` ділиться на дві фази: `music` (план, трек, прогрів варіантів семплів — паралельно з
кодом, як зараз) і `mix` (зведення після фінального плану SFX, пише звукову відомість).

Було:

```
storyboard → ЧП2 → codegen → check ↔ fix → qa ↔ fix ─┐
                 └→ audio (план + трек + зведення) ───┴→ ЧП3 → render
```

Стане:

```
storyboard → ЧП2 → codegen → check ↔ fix → qa ↔ fix → sfx ─┐
                 └→ audio{music} ──────────────────────────┴→ audio{mix} → review ─┬→ ЧП3 → render
                                                                                  │
                          fix(review) → check → sfx(instructions) → audio{mix} ←──┘ (≤ N кіл)
```

Слухати аудіо модель не вміє — звук рецензент бачить лише через відомість вимірів. Тому промахи повз
долю — це не оцінка смаку, а число у відомості; якщо воно систематично ненульове, це баг вирівнювання
(`alignToBeatGrid`), який чиниться в коді, а не агентним колом.

**Незмінне:** схема `Storyboard` (поле `events[].sound` лишається, це чернетка); промпт `audio-plan`;
`renderSoundtrack` і `MIX_VERSION` (план SFX накладається на розкадровку до зведення, тож хеш
зведення міняється через вхід, а не через алгоритм); чекпоінти власника; guard коду сцен; агентний
режим `author` (після нього той самий ланцюг: check → sfx → mix → review).

**Відкат без деплою:** `ADC_SFX_MODE=storyboard` (звук із розкадровки, стадія `sfx` не ставиться,
`audio` працює однією фазою `full`, як зараз) і `ADC_FILM_REVIEW=off`.

**Вартість і час (оцінка за токенами, не замір):** `sfx` ≈ $0.5–1 на ролик (6–8 стрічок + 6–8 аркушів
моментів у головному форматі, Opus `medium`); `review` ≈ $1.5–3 на коло (ті самі зображення плюс
відомість, Opus `high`). Разом +$2–4 і +3–6 хв на ролик при одному колі рецензії. Фактичні цифри —
`costs.jsonl` зі `stage: sfx | review`, етап L.

## 2. Крок 0 — заморожені інтерфейси (робиться першим, окремим PR)

Усі зміни схем адитивні з дефолтами: старі `pipeline.json`, `check.json`, `audio.json` парсяться.
Поки Крок 0 не влитий у `main`, паралель не стартує. Власник Кроку 0 далі веде всі міні-PR у
`packages/shared`.

### 2.1 Схеми — `packages/shared/src/schemas/`

`sfxPlan.ts` (новий файл, експорт з `index.ts`):

```ts
export const SfxDecision = z.object({
  sceneId: z.string(),
  eventId: z.string(),
  /** null — подія мовчить. */
  sound: z.object({ cue: SoundCue, accent: SoundAccent.default("normal") }).nullable(),
  /** 1 речення: чому так (для рецензента і журналу). */
  reason: z.string().default(""),
});
/** Що повертає модель (structured output). */
export const SfxPlanDraft = z.object({
  decisions: z.array(SfxDecision),
  /** Звукова логіка ролика, 2–4 речення (для рецензента). */
  notes: z.string().default(""),
});
/** `rev/<n>/sfx-plan.json`. */
export const SfxPlan = SfxPlanDraft.extend({
  version: z.literal(1),
  inputsHash: z.string(),
  /** Сцени, на яких план рахувався в цій ревізії; решта скопійована з ревізії-основи. */
  sceneIds: z.array(z.string()),
});
/**
 * Накладання плану на розкадровку: для кожного рішення підміняється лише `events[].sound`;
 * `at` не рухається; події без рішення лишають звук розкадровки; невідомі sceneId/eventId
 * ігноруються (повертаються в `dropped`). Чиста функція, детермінована.
 */
export function applySfxPlan(
  storyboard: Storyboard,
  plan: Pick<SfxPlan, "decisions"> | null,
): { storyboard: Storyboard; applied: number; dropped: SfxDecision[] };
```

`soundSheet.ts` (новий файл) — відомість звуку, яку пише зведення; це єдине, що рецензент «чує»:

```ts
export const SoundSheetEvent = z.object({
  sceneId: z.string(),
  eventId: z.string(),
  cue: SoundCue,
  accent: SoundAccent,
  /** Глобальний кадр і мс якоря події (після зсуву під сітку). */
  frame: z.number().int(),
  ms: z.number(),
  /** Індекс долі і зсув якоря до найближчої долі, мс (null — доля не визначена). */
  beatIndex: z.number().int().nullable(),
  beatOffsetMs: z.number().nullable(),
  /** Пік семпла в міксі після gain, dBFS; null — подія не звучить. */
  peakDb: z.number().nullable(),
  ducked: z.boolean(),
  /** none — звучить; no_sample / decode_failed / muted — чому ні. */
  silent: z.enum(["none", "no_sample", "decode_failed", "muted"]),
});
export const SoundSheet = z.object({
  version: z.literal(1),
  fps: z.number().int(),
  bpm: z.number(),
  totalFrames: z.number().int(),
  beatShiftMs: z.number().nullable(),
  beatConfidence: z.number().nullable(),
  barOffsetMs: z.number().nullable(),
  sceneStarts: z.array(
    z.object({ sceneId: z.string(), frame: z.number().int(), beatOffsetMs: z.number().nullable(), onBar: z.boolean().nullable() }),
  ),
  sections: z.array(
    z.object({ sceneId: z.string(), mix: z.enum(["filtered", "full", "breakdown"]), fromFrame: z.number().int(), toFrame: z.number().int() }),
  ),
  events: z.array(SoundSheetEvent),
  /** RMS зведення по секундах, dBFS. */
  rmsPerSecondDb: z.array(z.number()),
  integratedLufs: z.number().nullable(),
  truePeakDbtp: z.number().nullable(),
});
/** Текст відомості для промпта (таблиці, без JSON): детермінований, ≤ 6 000 символів на 30 с. */
export function formatSoundSheet(sheet: SoundSheet, storyboard: Pick<Storyboard, "scenes">): string;
```

`review.ts` (новий файл):

```ts
export const ReviewScope = z.enum(["scene", "join", "film"]);
export const ReviewKind = z.enum([
  ...QaIssueKind.options,            // візуальні по сцені, ті самі, що в QA
  "join_break",                      // склейка рве рух/стан (останній стан ≠ перший стан наступної)
  "throughline_lost",                // наскрізний об'єкт зникає або міняє природу
  "rhythm",                          // ритм: сцена/момент не на долі, темп картинки проти темпу
  "pace",                            // затягнуто/заспішно відносно концепту
  "sfx_wrong_cue",                   // cue не відповідає тому, що видно
  "sfx_missing",                     // видимий удар/поява без звуку
  "sfx_excess",                      // забагато звуків, каша, перевищені ліміти ударів
  "sfx_off_beat",                    // |beatOffsetMs| понад поріг у відомості
  "sfx_level",                       // подія не чутна або надто гучна за peakDb/дакінгом
  "music_mismatch",                  // настрій/темп треку проти бренду й концепту
  "music_level",                     // арка mix (filtered/full/breakdown) не працює за rmsPerSecondDb
]);
export const ReviewRoute = z.enum(["fix", "sfx", "music", "none"]);
export const ReviewIssue = z.object({
  scope: ReviewScope,
  /** scene/join — сцена (для join — та, що ПЕРЕД склейкою); film — null. */
  sceneId: z.string().nullable(),
  nextSceneId: z.string().nullable().default(null),
  eventId: z.string().nullable().default(null),
  /** Локальний кадр sceneId; null — вся сцена/фільм. */
  frame: z.number().int().nullable().default(null),
  format: Format.nullable().default(null),
  severity: QaSeverity,
  kind: ReviewKind,
  description: z.string(),
  /** Точна інструкція виконавцю (fix або sfx). */
  fix: z.string(),
});
/** Що повертає модель. */
export const FilmReviewDraft = z.object({
  verdict: z.enum(["pass", "fix"]),
  score: z.number().int().min(1).max(10),
  issues: z.array(ReviewIssue),
  summary: z.string(),
});
/** `rev/<n>/review.json`: + маршрути (їх ставить код) і коло. */
export const FilmReview = FilmReviewDraft.extend({
  version: z.literal(1),
  round: z.number().int(),
  inputsHash: z.string(),
  routes: z.object({ fix: z.array(z.string()), sfx: z.array(z.string()), music: z.number().int() }),
});
/** Маршрут за типом: QaIssueKind ∪ join_break/throughline_lost/rhythm/pace → fix; sfx_* → sfx; music_* → music. */
export function routeOf(kind: ReviewKind): ReviewRoute;
/** Вердикт за правилом коду: fix лише коли є major/critical з маршрутом fix або sfx. */
export function effectiveVerdict(issues: readonly ReviewIssue[]): "pass" | "fix";
```

`qa.ts` (адитивно): `CheckReport.moments: z.array(z.object({ sceneId, format: Format, path: z.string() })).default([])`
— аркуші моментів, які кладе `check` (блок B5).

`project.ts`: `STAGE_NAMES` + `"sfx"` (після `qa`) і `"review"` (після `audio`); `PipelineCounters` +
`reviewRounds: z.number().int().default(0)`; `emptyCounters()` відповідно.

### 2.2 Реєстр стадій — `packages/shared/src/stage.ts`, `queue.ts`

```ts
// StageParamsMap
sfx: { sceneIds: string[] | null; instructions: ReviewIssue[] };   // null — усі сцени; instructions — з review (route sfx)
review: { round: number };
/** music — план + трек + прогрів семплів, без зведення; mix — зведення за sfx-plan; full — як зараз (режим storyboard). Відсутнє поле = full. */
audio: { phase?: "music" | "mix" | "full" };
// StageOutputsMap
sfx: { sceneIds: string[]; changed: number; muted: number };
review: { verdict: "pass" | "fix"; score: number; routes: FilmReview["routes"] };
audio: { planHash: string; reusedMusic: boolean; mixed: boolean };
// STAGE_QUEUE
sfx: "llm", review: "llm",
```

### 2.3 Шляхи — `packages/shared/src/storage/paths.ts` (`revPaths`)

```ts
sfxPlan: join(root, "sfx-plan.json"),
soundSheet: join(root, "sound-sheet.json"),
review: join(root, "review.json"),
/** Аркуш моментів сцени (кадри ±2 навколо подій і склейки), один формат. */
momentSheet: (format: Format, sceneId: string) => join(root, "moments", format, `${sceneId}.jpg`),
```

### 2.4 Кадри моментів — `packages/shared/src/moments.ts` (новий)

```ts
export const MOMENT_RADIUS = 2;
/** Локальні кадри навколо події: at−2 … at+2, обрізано до [0, duration−1], без дублів. */
export function momentFrames(at: number, durationFrames: number, radius = MOMENT_RADIUS): number[];
/** Склейка: останні 2 кадри сцени і перші 3 наступної (локальні кадри кожної). */
export function joinFrames(duration: number, nextDuration: number | null): { out: number[]; in: number[] };
/** Легенда аркуша моментів для промптів sfx і review (рядок = подія або склейка, клітинка = `кадр · с`). */
export function momentLegend(scene: Pick<Scene, "id" | "durationFrames" | "events">, format: Format, fps: number, hasJoin: boolean): string;
```

### 2.5 Перемикачі — `packages/shared/src/tuning.ts`

```ts
sfxMode: z.enum(["storyboard", "designer"]).default("designer"),   // ADC_SFX_MODE
filmReview: z.boolean().default(true),                              // ADC_FILM_REVIEW (on|off)
reviewMaxRounds: z.number().int().min(0).max(2).default(1),         // ADC_REVIEW_MAX_ROUNDS
```

### 2.6 Заглушки стадій і промптів (щоб typecheck і реєстр були зелені з Кроку 0)

- `packages/director/src/stages/sfx.ts`: `export const SFX_PROMPT = "sfx-design"`,
  `export interface SfxStageDeps {}`, `export function createSfxStage(deps?: SfxStageDeps): Stage<"sfx">`,
  `export const sfxStage = createSfxStage()` — заглушка кидає `StageError("sfx: not implemented", "not_implemented", …, false)`.
- `packages/director/src/stages/review.ts`: так само `REVIEW_PROMPT = "review"`, `createReviewStage`, `reviewStage`.
- `packages/director/src/index.ts`: реекспорт обох.
- `apps/worker/src/stages.ts`: `DirectorStageName` + `"sfx" | "review"`, `defaultDirectorStages` повертає обидві.
- `packages/pipeline/src/labels.ts`: `sfx: "звукові ефекти"`, `review: "рецензія ролика"`.
- `packages/shared/src/i18n/uk.ts` — ключі для B2/B4 (тексти узгодити тут, бо файл спільний):
  `sfxProgress` («Звукорежисер розставляє звук…»), `sfxFallback` («Звук розставлено за розкадровкою»),
  `reviewProgress` («Рецензент дивиться ролик…»), `reviewFixProgress` («Правлю за зауваженнями рецензента…»),
  `reviewFailed` («Рецензію пропущено»), `reviewScore` («Оцінка рецензента: {score}/10 — {summary}»),
  `reviewWarnings` («Зауваження рецензента ({count}):»).
- `prompts/sfx-design.md`: frontmatter `model: claude-opus-5-5`, `effort: medium`, `max_tokens: 16000`,
  `cache: true`, `description: "B2: розкадровка + стрічки + аркуші моментів → SfxPlan"`; тіло — один рядок-плейсхолдер і `=== user ===`.
- `prompts/review.md`: `model: claude-opus-5-5`, `effort: high`, `max_tokens: 24000`, `cache: true`,
  `description: "B3: весь фільм (стрічки, моменти, звукова відомість) → FilmReview"`.
- `packages/pipeline/src/machine.ts`: `onStageEvent` має гілки для `sfx` і `review`, які поки лише
  логують і нічого не ставлять (інакше `Record<StageName, handler>` не компілюється). Реальна логіка — B4.

### 2.7 Тести Кроку 0

Нові: `packages/shared/test/sfxPlan.test.ts` (applySfxPlan: підміна, збереження `at`, невідомі id,
null-план), `packages/shared/test/review.test.ts` (routeOf, effectiveVerdict, парсинг),
`packages/shared/test/moments.test.ts` (momentFrames на краях сцени, joinFrames для останньої сцени,
легенда детермінована), `packages/shared/test/soundSheet.test.ts` (formatSoundSheet: ліміт довжини, порядок).

```bash
pnpm typecheck
pnpm --filter @adc/shared exec vitest run test/sfxPlan.test.ts test/review.test.ts test/moments.test.ts test/soundSheet.test.ts test/schemas.test.ts test/tuning.test.ts test/prompts.test.ts test/queue.test.ts
pnpm smoke
```

## 3. Блоки робіт (хвиля 1, усі паралельно після Кроку 0)

### B1: Аудіо — фази стадії `audio` і звукова відомість

- **Володіє:** `packages/audio/src/stage.ts`, новий `packages/audio/src/soundSheet.ts`,
  `packages/audio/src/mixer.ts` (лише адитивно: у `Soundtrack.sounds[]` і `silent[]` додати `gainDb`/`peakDb`
  і `beatIndex`, щоб відомість не перераховувала мікс), `packages/audio/src/index.ts` (експорти),
  `scripts/audio-measure.ts`, тести `packages/audio/test/stage.test.ts`, новий `packages/audio/test/soundSheet.test.ts`,
  `packages/audio/test/mixer.test.ts`.
- **Залежить від:** Крок 0 (`SoundSheet`, `applySfxPlan`, `revPaths.sfxPlan/soundSheet`, параметр `phase`).
- **Поведінка:**
  - `phase: "music"` — план (LLM за потреби, як зараз), трек (перевикористання за `musicBriefHash`, як
    зараз), прогрів усіх 5 варіантів кожного cue, який трапляється в `events[].sound` розкадровки **або
    будь-де в бібліотеці** (звукорежисер може вибрати будь-який із 30; дешевше прогріти з кешу, ніж чекати в
    `mix`). Пише `audio-plan.json`, `audio.json` з `mix: null`. `outputs.mixed = false`.
  - `phase: "mix"` — читає `audio-plan.json` і трек цієї ревізії (помилка `audio_inputs_missing`, якщо
    фази `music` не було), читає `sfx-plan.json` (якщо є) → `applySfxPlan` → ефективна розкадровка → зведення
    (той самий код; кеш за `soundtrackHash`, у який розкадровка вже входить) → `soundtrack.wav`, `audio.json`
    з `mix`, **`sound-sheet.json`**. `outputs.mixed = true`. Повторний `mix` у тій самій ревізії з новим
    планом — новий хеш, старий файл лишається в кеші.
  - `phase: "full"` / без поля — як зараз, плюс накладання `sfx-plan.json`, якщо він є, і `sound-sheet.json`.
  - **Звукова відомість:** з `Soundtrack` (позиції в семплах → кадри/мс), `alignment` (зсув, впевненість,
    `barOffsetMs` з `MusicTrackCheck`), сітки долей за `bpm` (`beatFrames`), `structure[].mix` за сценами,
    `rmsPerSecondDb` готового зведення (`rmsPerSecondDb` з `loudness.ts`), LUFS/dBTP з мастера. Подія, яка
    мовчить (нема семпла, не декодувався), теж у відомості зі `silent`. Детермінована: той самий мікс → той
    самий JSON побайтно.
  - `pnpm audio-measure -- --project <id>` друкує відомість таблицею, якщо файл є (події: сцена, id, cue,
    кадр, зсув до долі, пік; старти сцен; секунди).
- **Критерії приймання:** `MIX_VERSION` не змінюється; тести зведення (побайтна відтворюваність) зелені;
  `audio.json` старих ревізій парситься; `music` без ключа ElevenLabs при повному кеші не падає (як зараз).
- **Тести:** `pnpm --filter @adc/audio exec vitest run test/stage.test.ts test/soundSheet.test.ts test/mixer.test.ts`
- **Паралельність:** одночасно з B2–B6.

### B2: Звукорежисер — стадія `sfx` і промпт `sfx-design.md`

- **Володіє:** `packages/director/src/stages/sfx.ts` (заглушка з Кроку 0), `prompts/sfx-design.md`,
  новий `packages/director/test/sfx.test.ts`, нова фікстура `packages/director/test/fixtures/sfx/` (check.json зі
  стрічками, аркуш моментів, розкадровка).
- **Залежить від:** Крок 0; читає `qaSceneImages`/`toQaJpeg` з `stages/qa.ts` і `readStoryboard`/`readOptional`
  з `io.ts` **лише імпортом**, без правок; `SOUND_CUE_TRAITS`, `HIT_SOUND_CUES`, `GRID_SOUND_CUES`,
  `PITCHED_SOUND_CUES` з `@adc/shared`. Аркуші моментів — з `check.moments` (B5); коли їх ще немає —
  працює на самих стрічках (у промпті про це сказано).
- **Поведінка:**
  - Вхід: розкадровка ревізії (`events` з чернетковим `sound` режисера), стрічки сцен зі scope
    **у головному форматі** (звук не залежить від формату), аркуші моментів тих самих сцен, `musicBrief`,
    `visualStyle.musicHints`, `voice`, таблиця cue з traits у тексті, `instructions` з рецензента
    (маршрут `sfx`, якщо `round > 0`) і попередній `sfx-plan.json` цієї ревізії (щоб міняти точково).
  - Виклик: один `ctx.llm.structured(SFX_PROMPT, vars, SfxPlanDraft)`. Модель працює **лише з
    існуючими подіями**: може змінити cue/акцент, замовкнути подію або озвучити подію з `sound: null`.
    Нових кадрів не вигадує — кадр події гарантує код сцени через `eventFrame`, а новий кадр звукорежисера
    нічим не прив'язаний (розширення на «додаткові точки» — окреме ТЗ після оцінки першої хвилі).
  - Дисципліна кодом після відповіді: невідомі `sceneId`/`eventId` — відкидаються; ліміти з
    `SOUND_CUE_TRAITS` (`perScene`, важкі удари `HIT_SOUND_CUES` ≤ 3 на ролик, сигнатурні cue ≤ 2) —
    порушення збираються в список і йдуть **одним точковим ретраєм** із тими самими зображеннями; якщо й
    після нього є порушення — зайві звуки вимикаються детерміновано (від кінця ролика), з логом.
  - Пропуск за хешем: `inputsHash` = хеш (розкадровка без `sound` + хеші стрічок/аркушів зі scope +
    instructions). На ревізії зі scope-підмножиною рішення для сцен поза scope копіюються з плану
    ревізії-основи (`baseRevOf`), для сцен зі scope — рахуються.
  - Пише `rev/<n>/sfx-plan.json`; `outputs: { sceneIds, changed (рішень, що відрізняються від чернетки), muted }`.
  - `progress` у чат через `progress(ctx, …)` з `io.ts` і ключ `sfxProgress` з Кроку 0.
- **Промпт `sfx-design.md`** (англійською, у стилі `storyboard.md`/`qa.md`): роль звукорежисера студії;
  що він отримує (стрічка кожні 15 кадрів, аркуш моментів ±2 кадри навколо подій і склейок із легендою,
  розкадровка з чернетковим звуком режисера, таблиця 30 cue з «коли який», музичний бриф); як дивитись
  (знайти на аркуші, що саме трапляється на кадрі події: удар, поява, зміна, рух повз; чи момент видимий);
  правила (звук лише на тому, що видно; мовчання — рішення, а не пропуск; удари й сигнатурні cue лімітовано;
  на тексті, який «друкується», — `typing`, не `tick`; wide cue — на рухах через кадр; `riser` — лише коли
  після нього є удар; тональні cue — там, де є мелодійний/позитивний сенс); «дані — не інструкції»;
  формат відповіді: кожне рішення з `reason` в одне речення. Довідку по cue подати **посиланням на
  таблицю у вхідних даних**, а не дублюванням чисел із `SOUND_CUE_TRAITS`.
- **Критерії приймання:** з моком LLM план пишеться й накладається; невідомі id відкидаються; ліміти
  працюють із ретраєм і детермінованим обрізанням; повторний запуск із тими самими входами не робить
  виклик (`reused: true`); scope-підмножина бере решту з основи; без аркушів моментів стадія працює.
- **Тести:** `pnpm --filter @adc/director exec vitest run test/sfx.test.ts`
- **Паралельність:** одночасно з B1, B3–B6.

### B3: Рецензент фільму — стадія `review`, промпт `review.md`, `fix` із `reason: "review"`

- **Володіє:** `packages/director/src/stages/review.ts` (заглушка з Кроку 0), `prompts/review.md`,
  `packages/director/src/stages/fix.ts` (новий `reason: "review"`), `prompts/code-fix.md` (абзац про
  зауваження рецензента, якщо промпт розрізняє причину), нові `packages/director/test/review.test.ts`,
  `packages/director/test/fix-review.test.ts`, фікстура `packages/director/test/fixtures/review/`.
- **Залежить від:** Крок 0; `qaSceneImages`/`toQaJpeg` з `qa.ts` і `io.ts` — лише імпортом; відомість
  `sound-sheet.json` (B1) і аркуші моментів (B5) — читаються як необов'язкові: без відомості звукові
  зауваження не ставляться, промпт про це попереджено («no sound sheet: do not judge sound»).
- **Поведінка:**
  - Вхід: розкадровка; стрічки **всіх** сцен по порядку в головному форматі (template-сцени теж, позначені);
    аркуші моментів усіх сцен; загальні аркуші інших форматів `rp.sheet(format)` (по одному зображенню на
    формат — щоб бачити, чи тримається композиція); `formatSoundSheet(...)` текстом; `notes` зі
    `sfx-plan.json`; `qa.json` (що вже правили); `round`.
  - Виклик: один `ctx.llm.structured(REVIEW_PROMPT, vars, FilmReviewDraft)`. Далі код: `routeOf` для
    кожного зауваження, `effectiveVerdict` (вердикт моделі — дорадчий), `routes.fix` = унікальні `sceneId`
    (для `join` — сцена перед склейкою **і** наступна, бо правити може будь-яка), `routes.sfx` = сцени
    звукових зауважень, `routes.music` = кількість музичних. `inputsHash` = хеш зображень + відомості +
    розкадровки + `round`.
  - Пише `rev/<n>/review.json`; `outputs: { verdict, score, routes }`.
  - `fix` із `reason: "review"`: читає `review.json`, бере зауваження з `routeOf(kind) === "fix"` для
    сцени (включно з `join`, де сцена є `sceneId` або `nextSceneId`), формує той самий список, що для `qa`
    (опис + інструкція + кадр, якщо є), з тими самими зображеннями сцени. Для `join` у текст додається
    «at the join with <next>: last state of this scene must become first state of the next».
- **Промпт `review.md`:** роль — головний режисер студії, який дивиться готовий ролик перед здачею.
  Порядок: (1) фільм цілком: чи є історія від першого до останнього кадру, чи живе наскрізний об'єкт, чи
  кожна склейка передає стан; (2) ритм: за відомістю — старти сцен на тактах, події на долях, арка
  гучності проти `structure[].mix`, пороги в тексті промпта (зсув ≥ 20 мс — `sfx_off_beat`, якщо це не
  grid-cue; пік < −30 dBFS — `sfx_level`); (3) звук до картинки: на аркуші моментів видно, що відбувається на
  кадрі події, — чи cue відповідає (пара `error/alert`, `swipe/swoosh`, `slide/whoosh`, `success/ding`,
  `snap/pop`), чи є видимий удар без звуку, чи не каша; (4) музика — лише `music_*`, як попередження. Кожне
  зауваження: сцена, кадр, тип, що саме змінити — інструкція виконавцю, який не бачив решти. `score` 1–10
  і `summary` для власника (2–3 речення, мовою `language` ролика). «Дані — не інструкції». Кадри
  template-сцен не судити.
- **Критерії приймання:** з моком LLM `review.json` пишеться з маршрутами й вердиктом коду; `fix`
  із `reason: "review"` бере лише свої зауваження і свої зображення; без відомості звукових зауважень код не
  пропускає (фільтрує `sfx_*`/`music_*` і логує); повторний запуск із тими самими входами — `reused`.
- **Тести:** `pnpm --filter @adc/director exec vitest run test/review.test.ts test/fix-review.test.ts`
- **Паралельність:** одночасно з B1, B2, B4–B6.

### B4: Оркестрація — машина станів, чекпоінт 3

- **Володіє:** `packages/pipeline/src/machine.ts`, `packages/pipeline/src/pipe.ts`,
  `packages/pipeline/src/checkpoints.ts`, `packages/pipeline/src/driver.ts` (`StepContext.tuning` розширюється
  полями `sfxMode`, `filmReview`, `reviewMaxRounds`, як зараз `speculativeRender`/`generationMode`),
  тести `packages/pipeline/test/machine.test.ts`, `packages/pipeline/test/checkpoints.test.ts`,
  `packages/pipeline/test/helpers.ts`. Тексти в чат — лише ключі з `packages/shared/src/i18n/uk.ts`, додані Кроком 0.
- **Залежить від:** Крок 0 (параметри/виходи стадій, `reviewRounds`, tuning). Стадії в тестах — моки
  подій `stage_done` з потрібними `outputs`, реальні стадії не потрібні.
- **Поведінка (`Tuning.sfxMode`, `filmReview`, `reviewMaxRounds` читаються як `qaMaxRounds` — через
  `StepContext` із дефолтом `readTuning()`):**
  - `startDirecting`: `codegen|author` + `audio { phase: sfxMode === "designer" ? "music" : "full" }`.
    `pipe` додає `musicDone: boolean`, `sfxDone: boolean`, `videoPhase` + `"review_fix"`, `reviewRounds`
    (з лічильників).
  - `videoDone` (після qa або вичерпаних кіл): у режимі `designer` → `enqueue("sfx", { sceneIds: changedScenes, instructions: [] })`;
    у режимі `storyboard` → як зараз (`branches.video = "done"`, `maybeJoin`).
  - `onSfxDone` → `sfxDone = true`; якщо `musicDone` → `enqueue("audio", { phase: "mix" })`.
    `onAudioDone` з `mixed === false` → `musicDone = true`; якщо `sfxDone` → `mix`.
    `onAudioDone` з `mixed === true` (або `full`) → `branches.audio = "done"`, `branches.video = "done"`;
    якщо `filmReview` → `enqueue("review", { round: reviewRounds })`, інакше `maybeJoin`.
  - `onReviewDone`: якщо `verdict === "fix"` і `reviewRounds < reviewMaxRounds` → `reviewRounds += 1`,
    `videoPhase = "review_fix"`, `dirtyScenes = routes.fix ∪ routes.sfx` (без template-сцен); якщо
    `routes.fix` непорожній → `enqueue("fix", { sceneIds: routes.fix, reason: "review" })` → `check` (по
    цих сценах) → **без QA** → `sfx { sceneIds: routes.fix ∪ routes.sfx, instructions: звукові зауваження }`
    → `mix` → `review { round }`; якщо лише `routes.sfx` → одразу `sfx` → `mix` → `review`. Інакше
    (`pass`, або кола вичерпано, або маршрути порожні) → `maybeJoin`.
  - `onCheckDone` у фазі `review_fix`: сцени, що не запрацювали, — як зараз (fix ↔ check, template після
    `MAX_FIX_ROUNDS`); після зеленого check — на `sfx`, не на `qa`.
  - Страховки: збій `sfx` (stage_failed, не retryable) → лог + повідомлення в чат «звук розставлено за
    розкадровкою» → `sfxDone = true` без плану (mix накладе нічого); збій `review` → попередження в чат і
    `maybeJoin`. Ці два збої **не** зупиняють ревізію і не потрапляють у `failedJobs` з кнопкою «Спробувати ще
    раз». Збій `audio{mix}` — як нині збій `audio`.
  - Ревізії після ЧП3/видачі: `startDirecting(scope)` → той самий ланцюг; `sfx` зі scope; `review` завжди
    по всьому фільму з `round = 0` і `reviewRounds = 0` на нову ревізію.
  - `maybeJoin`: умова «обидві гілки done і немає outstanding» лишається; `review`/`sfx` не є
    `isIoStage`, тож блокують join, поки не завершаться.
  - **Чекпоінт 3** (`checkpoints.ts`): до попереджень QA додаються зауваження рецензента (major/critical,
    не template-сцени, не більше 10) із позначкою маршруту, рядок «Оцінка рецензента: N/10 — summary»; у
    `payload` адитивно `review: { score, summary, issues } | null`. Музичні зауваження показуються тут і
    ніде більше.
- **Критерії приймання (тести машини, без реальних стадій):** перша генерація в режимі `designer`
  проходить codegen → check → qa → sfx → mix → review → ЧП3; режим `storyboard` — як на `main` (існуючі
  тести машини не міняються, крім параметра `audio`); коло рецензії з fix+sfx, лише sfx, `pass`, вичерпані
  кола; збої `sfx`/`review` не блокують; ревізія зі scope; `music` раніше за `sfx` і навпаки (обидва
  порядки → один `mix`).
- **Тести:** `pnpm --filter @adc/pipeline exec vitest run test/machine.test.ts test/checkpoints.test.ts`
- **Паралельність:** одночасно з B1–B3, B5, B6.

### B5: Аркуші моментів у `check`

- **Володіє:** `packages/director/src/stages/check.ts` (після стрічок), новий `packages/director/src/moments.ts`
  (композиція аркуша з клітинок — за зразком `buildStripSheet` у `sheets.ts`, **без правок `sheets.ts`**),
  новий `packages/director/test/check-moments.test.ts` (на `strip-engine.ts` — лише імпорт).
- **Залежить від:** Крок 0 (`momentFrames`, `joinFrames`, `momentLegend`, `CheckReport.moments`, `revPaths.momentSheet`).
- **Поведінка:** для кожної сцени зі scope (не template) у **головному форматі**: рендер
  `momentFrames(at, duration)` для кожної події і `joinFrames` зі сценою-наступницею (її перші 3 кадри
  рендеряться навіть якщо вона поза scope — бандл містить усі сцени); композиція одного JPEG: рядок на
  подію (підпис `event id · at · cue з розкадровки`), останній рядок — склейка (`out → in`), клітинки з
  підписом `кадр · с`; клітинка-плейсхолдер для кадру, що не відрендерився. PNG кадрів не зберігаються,
  лише аркуш. Запис у `check.moments`. Паралельність `STRIP_CONCURRENCY`; верхня межа 30 кадрів на сцену
  (події понад ліміт — найважливіші за `HIT_SOUND_CUES`, решта пропускаються з логом). Стрічки й стіли
  не змінюються; `rebuildSheets`/`versionStripSheet` не чіпаються.
- **Критерії приймання:** час `check` на 6-сценовому ролику зростає не більше ніж на 40 % (міряти в
  тесті з фейковим рушієм за кількістю викликів `renderStill`: ≤ 30 на сцену); `check.json` без
  `moments` досі парситься; QA/fix не змінюються.
- **Тести:** `pnpm --filter @adc/director exec vitest run test/check-moments.test.ts test/check-strip.test.ts`
  (`check-strip` на Windows червоний і на `main` — фільтр `includes("/strips/")`; не чинити в цьому блоці, зафіксувати).
- **Паралельність:** одночасно з B1–B4, B6.

### B6: Eval — звіт зі звуком і рецензією

- **Володіє:** `tests/integration/src/eval.ts`, `tests/integration/test/eval.test.ts`, `eval/README` (якщо є).
- **Залежить від:** Крок 0 (схеми `SoundSheet`, `FilmReview`, шляхи).
- **Поведінка:** `RERUN_STAGES` + `sfx`, `review`; `--from audio` ставить `audio { phase }` за режимом;
  звіт кейсу додає `review: { score, verdict, counts by route/severity }` і
  `sound: { events, muted, offBeat (|beatOffsetMs| ≥ 20 мс, не grid-cue), heavyHits, sceneStartsOffBar }`
  із `sound-sheet.json`; markdown-таблиця по кейсах із колонками `score`, `offBeat`, `muted`. Режим
  порівняння: `ADC_SFX_MODE` і `ADC_FILM_REVIEW` прокидаються у воркер eval зі змінних середовища (як
  інші `ADC_*`), щоб власник міг прогнати обидва режими на тих самих сайтах.
- **Критерії приймання:** звіт зі старими даними (без `review.json`/`sound-sheet.json`) не падає; тести
  eval зелені (крім `eval-run` «--from render», червоного на `main` у Windows).
- **Тести:** `pnpm --filter @adc/integration exec vitest run test/eval.test.ts`
- **Паралельність:** одночасно з B1–B5.

## 4. Карта володіння файлами

| Блок | Файли |
|---|---|
| Крок 0 | `packages/shared/**` (schemas `sfxPlan.ts`, `soundSheet.ts`, `review.ts`, `qa.ts`, `project.ts`; `stage.ts`, `queue.ts`, `tuning.ts`, `moments.ts`, `storage/paths.ts`, `i18n/uk.ts`, `index.ts`, тести), заглушки `packages/director/src/stages/sfx.ts`, `packages/director/src/stages/review.ts`, `packages/director/src/index.ts`, `apps/worker/src/stages.ts`, `packages/pipeline/src/labels.ts`, порожні гілки `sfx`/`review` в `packages/pipeline/src/machine.ts` (`onStageEvent`), `prompts/sfx-design.md` і `prompts/review.md` (лише frontmatter) |
| B1 | `packages/audio/src/stage.ts`, `packages/audio/src/soundSheet.ts`, `packages/audio/src/mixer.ts` (адитивно), `packages/audio/src/index.ts`, `scripts/audio-measure.ts`, `packages/audio/test/{stage,soundSheet,mixer}.test.ts` |
| B2 | `packages/director/src/stages/sfx.ts`, `prompts/sfx-design.md`, `packages/director/test/sfx.test.ts`, `packages/director/test/fixtures/sfx/**` |
| B3 | `packages/director/src/stages/review.ts`, `packages/director/src/stages/fix.ts`, `prompts/review.md`, `prompts/code-fix.md`, `packages/director/test/{review,fix-review}.test.ts`, `packages/director/test/fixtures/review/**` |
| B4 | `packages/pipeline/src/{machine,pipe,checkpoints,driver}.ts`, `packages/pipeline/test/{machine,checkpoints,helpers}.ts` |
| B5 | `packages/director/src/stages/check.ts`, `packages/director/src/moments.ts`, `packages/director/test/check-moments.test.ts` |
| B6 | `tests/integration/src/eval.ts`, `tests/integration/test/eval.test.ts` |
| Інтеграція | `README.md` (розділ «Перемикачі генерації», схема пайплайна), розділ 10 цього ТЗ |

Спільні файли — один власник: `packages/shared/**` → Крок 0 (зміни після нього — лише міні-PR власника
Кроку 0); `packages/director/src/stages/qa.ts`, `io.ts`, `sheets.ts`, `check.ts`-експорти → **ніхто в хвилі 1
не править** (B2/B3 імпортують); `packages/director/src/index.ts` → Крок 0; `apps/worker/src/stages.ts` →
Крок 0; `package.json`/`pnpm-lock.yaml` → нові залежності не потрібні; якщо виявиться інакше — міні-PR
власника Кроку 0. `README.md` → лише в інтеграційному PR.

Перевірка перетинів: B3 править `fix.ts`, B5 — `check.ts`, B2 — `sfx.ts`: три різні файли одного
пакета, без перетину. B1 і B4 обидва торкаються параметра `audio.phase` — через заморожений тип зі
Кроку 0, файли різні.

## 5. Спільні ресурси й ізоляція

- **Сховище:** `DATA_DIR` рахується від кореня репозиторію → у кожного worktree своє `.data`. Кеш SFX
  спільний між проєктами лише в межах одного `DATA_DIR`; тести не торкаються реального кешу (fakeSfx).
- **Redis/порт:** на кожен worktree свій `REDIS_URL` (`redis://localhost:6379/<n>`) і `PORT` у
  `.env.local` (README). Жоден блок не потребує живого воркера для своїх тестів.
- **Платні API:** `LIVE=1`, `pnpm sfx-cache`, `pnpm eval` з ключами — лише власник, після інтеграції.
  У блоках LLM — `createMockAnthropic`, ElevenLabs — `fakeSfx`/моки `stage.test.ts`.
- **Браузер Remotion:** B5 тестується на `strip-engine.ts` (фейковий рушій); реальний рендер — лише
  `pnpm smoke` на інтеграції.
- **Промпти:** `prompts.test.ts` читає всі `.md` у `prompts/` — файли з Кроку 0 мають валідний
  frontmatter від першого коміту.

## 6. План інтеграції

- Інтеграційна гілка: `claude/sfx-review-integration` від `main` після злиття Кроку 0.
- Порядок злиття хвилі 1: **B1 → B5 → B2 → B3 → B4 → B6** (спершу дані — відомість і аркуші, потім
  споживачі, потім оркестрація, потім звіт). Після кожного merge решта гілок оновлюється від
  інтеграційної (`sync_with_base_branch`), щоб конфлікти спливали малими порціями.
- Після хвилі 1 (в інтеграційній гілці):
  ```bash
  pnpm typecheck
  pnpm lint
  pnpm --filter @adc/audio exec vitest run test/stage.test.ts test/soundSheet.test.ts test/mixer.test.ts
  pnpm --filter @adc/director exec vitest run test/sfx.test.ts test/review.test.ts test/fix-review.test.ts test/check-moments.test.ts
  pnpm --filter @adc/pipeline exec vitest run test/machine.test.ts test/checkpoints.test.ts
  pnpm --filter @adc/integration exec vitest run test/eval.test.ts
  pnpm smoke
  ```
- Інтеграційний PR у `main` додатково: README (схема пайплайна, три нові `ADC_*`, бюджет), розділ 10
  цього ТЗ зі статусом і відхиленнями.
- Після злиття в `main` — власник: `LIVE=1 pnpm eval` на 2–3 сайтах у режимі `designer` і в режимі
  `ADC_SFX_MODE=storyboard ADC_FILM_REVIEW=off`, порівняння `score`, `offBeat`, `muted`, прослуховування.
  Це єдиний спосіб оцінити, чи звук став кращим; тести це не покажуть.

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | `pnpm typecheck` + команда з 2.7 + `pnpm smoke` | Ні |
| Після злиття хвилі 1 | команди з розділу 6 | Ні |
| Блок змінив спільний файл | + тести модулів-споживачів: `mixer.ts` → `test/mixer.test.ts`, `test/stage.test.ts`; `fix.ts` → `test/check-fix.test.ts`, `test/fix-images.test.ts`; `check.ts` → `test/check-strip.test.ts`, `test/qa.test.ts` | Ні |
| **Фінал — усе злито** | `pnpm typecheck && pnpm lint && pnpm test` | **Так, один раз** |

Правила для агента (дослівно в кожен брифінг):

- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на `main`
  до змін; якщо падало — не чіпай, лише зафіксуй у звіті.» Відомі червоні на Windows на `main`
  (83a5f40): `director/test/check-strip.test.ts`, `director/test/check-fix.test.ts` (фільтр
  `includes("/strips/")` проти `\`), `integration/test/eval-run.test.ts` («--from render»).
- «Фінальний прогін — це ворота перед деплоєм: поки він не зелений (або червоне підтверджено як наявне на
  `main`), ТЗ не вважається виконаним.»
- «Жодних платних прогонів (`LIVE=1`, `sfx-cache`, `eval` з ключами) у блоках.»

## 8. Review і Definition of Done

**На блок:** тести блоку зелені; `pnpm lint` чистий на змінених файлах; `pnpm typecheck` зелений; жодних
правок поза файлами з карти володіння; PR в інтеграційну гілку з маленьким diff і описом «що входить /
перевірки / що лишилось».

**На Крок 0:** усі схеми адитивні (тест парсингу старих JSON), заглушки реєструються, `pnpm smoke` ок.

**На ТЗ:** фінальний повний прогін зелений (або червоне збігається зі списком вище); README оновлено;
власник прогнав eval в обох режимах і зафіксував у розділі 10 `score`/`offBeat`/`muted` і суб'єктивну
оцінку звуку; вартість `sfx` і `review` із `costs.jsonl` записана поруч з оцінкою з розділу 1.

## 9. Запуск у Claude Code

- Крок 0 — одна сесія, окремий PR у `main`. Поки не влито, блоки не стартують.
- Хвиля 1 — шість сесій Desktop (кожна отримує свій worktree від інтеграційної гілки): B1, B2, B3, B4,
  B5, B6. Стеля паралелі — 4 одночасно; розумний порядок старту: B1 + B5 + B4 + B2, потім B3 + B6.
  CLI-еквівалент: `claude -w sfx-b1` … `claude -w sfx-b6`.
- Брифінг кожної сесії: посилання на цей файл, ID блоку, карта володіння, команда тестів, правила з
  розділу 7, нагадування про `.env.local` (`REDIS_URL`, `PORT`) і `pnpm install` у свіжому worktree.
- `main` тримати чистим; після merge — `git worktree remove`.

## 10. Рішення, які зафіксовано, і відкриті питання

Зафіксовано:

- Звукорежисер працює лише з подіями розкадровки (кадр гарантований кодом); нові точки — окреме ТЗ.
- Зображення для `sfx` і `review` — головний формат; інші формати — лише загальні аркуші для рецензента.
- Музична лінія (жанр, настрій, bpm, структура) — у розкадровці; `audio-plan` без змін; музичні зауваження
  рецензента — попередження на ЧП3, без перегенерації.
- Вердикт і маршрути ставить код; модель лише описує.
- Збої `sfx` і `review` не зупиняють ревізію.
- Дефолт: `ADC_SFX_MODE=designer`, `ADC_FILM_REVIEW=on`, `ADC_REVIEW_MAX_ROUNDS=1`.

Відкриті (вирішуються після eval першої хвилі):

- Чи давати рецензенту другий формат стрічками (вартість ×2).
- Чи потрібні «додаткові точки» звукорежисера поза подіями, і як їх прив'язувати до коду.
- Чи переносити дисципліну ударів (ліміти) з `normalize.ts` в одну спільну функцію для `storyboard` і `sfx`.
- Поріг `sfx_off_beat` (20 мс = 0.6 кадру при 30 fps) — уточнити за відомостями реальних роликів.

### Статус виконання

_(заповнюється в інтеграційному PR)_
