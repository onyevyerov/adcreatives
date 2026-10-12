# ТЗ: паритет із роликом з діалогового вікна — звук, вхід, агентний автор

Дата: 2026-10-12. Формат — parallel-ready: Крок 0 заморожує інтерфейси, далі блоки без спільних файлів.
Аналіз, на якому ґрунтується ТЗ: `docs/analysis/2026-10-12-opus-chat-vs-pipeline.md`.

## 1. Мета і контекст

Ролик Opus 5.5 з діалогового вікна (`one line.mp4`, 16:9, 25 с) помітно сильніший за ролик нашого
пайплайна (проєкт `9LDzhp-nIqi7JSc_CF-wn`, 9:16, 24 с, $3.96) з трьох причин: автор знав більше про продукт,
мав у 15–20 разів більший бюджет на «подивитися свої кадри й переробити», і володів картинкою та звуком
з одного таймлайну. Це ТЗ закриває етапи 1–3 плану паритету:

1. **Звук** — рівні й спільний простір подій, музичний дакінг, ліміт ударів, один `compose` замість чанків,
   перевірка треку після генерації.
2. **Вхід** — глибший краул, блок «речовина продукту» в бренд-кіті, нові ролі `items`, семантична палітра
   й моношрифт, живий фон, геометрія лого для коду.
3. **Агентний режим генерації** — стадія `author`: один агент пише сцени, рендерить стрипи, дивиться їх і
   править сам, у межах бюджету; стара зв'язка codegen → check → qa → fix лишається як `pipeline`-режим.

Етап 4 (процедурний аудіодвигун із таймлайну) у це ТЗ не входить. Рішення власника 2026-10-12 лишається:
звуки подій — бібліотека ElevenLabs (`prompts/elevenlabs/sfx-cues.md`), музика — ElevenLabs.

**Незмінне:** guard коду (без мережі, випадковості, зовнішніх ресурсів), детермінований рендер, «тільки
правда» в кадрі (всі тексти — з `allowedScreenTexts`, числа й обіцянки — через `claims`), safe area, три
формати з одного коду, чекпоінти власника, фінал на лого з CTA.

**Вартість:** агентний режим оцінюється в $15–30 на ролик (оцінка за токенами чат-сесії, не замір).
Дефолт лишається `pipeline`; `agent` вмикається env-перемикачем. Фактичні $ і хвилини фіксуються в етапі L
з `costs.jsonl` / `trace.jsonl`.

## 2. Крок 0 — заморожені інтерфейси (робиться першим, окремим PR)

Усі зміни схем — **адитивні з дефолтами**: старі `brandkit/v*.json`, `storyboard.json`, `audio.json`,
`project.json` мають парситись. Поки Крок 0 не влитий у `main`, паралель не стартує.

### 2.1 Бренд-кіт — `packages/shared/src/schemas/brandkit.ts`

```ts
export const Palette = z.object({
  primary: HexColor, secondary: HexColor, accent: HexColor,
  background: HexColor, surface: HexColor, textOnDark: HexColor, textOnLight: HexColor,
  /** Семантичні кольори; null — бренд-кіт виводить їх кодом (B4), у Theme вони завжди є. */
  danger: HexColor.nullable().default(null),
  warning: HexColor.nullable().default(null),
  success: HexColor.nullable().default(null),
});

export const Typography = z.object({
  heading: FontChoice, body: FontChoice,
  /** Моношрифт для чисел, eyebrow і міток; null — B4 підбирає з fonts.json. */
  mono: FontChoice.nullable().default(null),
  detected: z.array(z.string()),
});

/** Речовина продукту: що він робить і як виглядає результат. Кожен рядок — дослівно з тексту сайту. */
export const ProductSubstance = z.object({
  /** Кроки роботи з продуктом у порядку: "Вставте URL", "AI сканує сайт", "Отримуєте план". */
  steps: z.array(z.object({ name: z.string(), detail: z.string().nullable() })).default([]),
  /** Що перевіряє / з чого складається: категорії, напрями, модулі. */
  checks: z.array(z.string()).default([]),
  /** Приклади результату: проблема, серйозність, оцінка, пояснення, що робити. */
  exampleIssues: z.array(z.object({
    title: z.string(),
    severity: z.enum(["critical", "moderate", "minor"]).nullable(),
    score: z.string().nullable(),
    explanation: z.string().nullable(),
    fix: z.string().nullable(),
    effort: z.string().nullable(),
  })).default([]),
  /** Рядки плану/списку задач з групою ("1 тиждень") і оцінкою ("3 години"). */
  planRows: z.array(z.object({ text: z.string(), group: z.string().nullable(), effort: z.string().nullable() })).default([]),
  /** Продукти/модулі одним рядком. */
  products: z.array(z.object({ name: z.string(), oneLiner: z.string().nullable() })).default([]),
  /** Порівняння з альтернативою: критерій, ми, вони. */
  comparisons: z.array(z.object({ criterion: z.string(), us: z.string(), alternative: z.string() })).default([]),
});
export type ProductSubstance = z.infer<typeof ProductSubstance>;

// BrandKit:
substance: ProductSubstance.default({ steps: [], checks: [], exampleIssues: [], planRows: [], products: [], comparisons: [] }),
```

Правило для всіх блоків: рядки `substance` перевіряються кодом на дослівність (`verifySubstance` у B2):
рядок, якого нема в `site-text.txt` (нормалізація пробілів і регістру), викидається з попередженням у
`fixes`. Тому `claims` для текстів зі `substance` проходять без змін у `packages/director/src/claims.ts`.

### 2.2 Розкадровка — `packages/shared/src/schemas/storyboard.ts`

```ts
export const OnScreenRole = z.enum([
  "heading", "label", "item", "number", "badge", "caption", "quote", "button",
  /** Дрібний надзаголовок над headline або блоком: "КРОК 2", "ЩО ВИ ОТРИМУЄТЕ". */
  "eyebrow",
  /** Стан/серйозність у рядку UI-мока: "Критично", "Готово", "3 години". */
  "status",
]);
```

`allowedScreenTexts` (`packages/shared/src/screen-texts.ts`) не змінюється: усі `items[].text` уже дозволені.

### 2.3 Аудіо — `packages/shared/src/schemas/audioPlan.ts`

```ts
/** Перевірка згенерованого треку (A2): чи є бочка на сітці і чи нема провалів. */
export const MusicTrackCheck = z.object({
  bpm: z.number(),
  kickOnsets: z.number().int(),
  beatConfidence: z.number(),
  /** Провали RMS > 1 с відносно медіани треку, мс. */
  gaps: z.array(z.object({ fromMs: z.number().int(), toMs: z.number().int(), dropDb: z.number() })),
  rmsPerSecondDb: z.array(z.number()),
  ok: z.boolean(),
});
export type MusicTrackCheck = z.infer<typeof MusicTrackCheck>;

// MusicMeta (packages/shared/src/schemas/audioPlan.ts або де він оголошений):
check: MusicTrackCheck.nullable().default(null),
attempts: z.number().int().min(1).default(1),
```

`AudioPlan.compositionPlan.chunks` лишається в схемі (старі плани парсяться), але A2 завжди пише один чанк.

### 2.4 Стадія `author`, режим генерації, бюджети

`packages/shared/src/schemas/project.ts`: `STAGE_NAMES` += `"author"`. `packages/shared/src/queue.ts`:
`STAGE_QUEUE.author = STAGE_QUEUE.codegen` (та сама черга режисера).

`packages/shared/src/stage.ts`:

```ts
// StageParamsMap
author: { sceneIds: string[] | null; instructions: Array<{ sceneId: string; instruction: string }> };
// StageOutputsMap
author: { sceneIds: string[]; iterations: number; renders: number; usd: number; stoppedBy: "done" | "budget" | "iterations" | "time" };
```

`packages/shared/src/tuning.ts`:

```ts
generationMode: z.enum(["pipeline", "agent"]).default("pipeline"),   // ADC_GENERATION_MODE
authorTokenBudget: z.number().int().min(500_000).default(3_000_000), // ADC_AUTHOR_TOKEN_BUDGET (input+output+cache за стадію)
authorMaxIterations: z.number().int().min(5).max(80).default(40),    // ADC_AUTHOR_MAX_ITERATIONS
authorMaxMinutes: z.number().int().min(5).max(60).default(25),       // ADC_AUTHOR_MAX_MINUTES
```

### 2.5 LLM — цикл з інструментами, `packages/shared/src/llm/client.ts`

```ts
export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** Результат інструмента: текст і/або зображення, що йдуть у tool_result. */
  run(input: I, signal?: AbortSignal): Promise<{ text?: string; images?: ImageInput[] }>;
}
export interface LlmAgentOptions extends Omit<LlmCallOptions, "images" | "onText"> {
  tools: AgentTool[];
  maxIterations: number;
  /** Сумарні токени (input + output + cacheWrite + cacheRead) на весь цикл; при перевищенні — зупинка. */
  tokenBudget: number;
  onIteration?: (info: { iteration: number; tool: string | null; usd: number; tokens: number }) => void;
}
export interface LlmAgentResult extends LlmTextResult {
  iterations: number;
  stoppedBy: "done" | "budget" | "iterations" | "signal";
}
// Llm:
agent(name: string, vars: PromptVars, opts: LlmAgentOptions): Promise<LlmAgentResult>;
```

Крок 0 додає сигнатуру, мок (`packages/shared/src/llm/mock.ts`: `agent` виконує задані сценарієм
виклики інструментів) і заглушку `packages/shared/src/llm/agent.ts` (`runAgent` кидає
`LlmError("agent_not_implemented")`), яку `client.ts` уже викликає з `agent()`. Реалізація проти Anthropic SDK
(`tool_use` / `tool_result`, стрім, кеш system + tools) — блок C1, і він чіпає лише `agent.ts`.

Так само Крок 0 створює скелет пакета `packages/author` (`package.json` з ім'ям `@adc/author`, `src/index.ts`
експортує `authorStage`, що кидає `StageError("author_not_implemented")`, порожній `test/`), і
`apps/worker/src/stages.ts` реєструє `author: authorStage` з `@adc/author`. Тоді C1 наповнює пакет, а C2
підключає стадію до машини станів, не торкаючись файлів одне одного.

### 2.6 Motion-kit — імена, проти яких пишуться промпти (B5) і реалізація (B4)

```ts
// packages/motion-kit/src/media/Backdrop.tsx
variant: "solid" | "gradient" | "noise" | "shapes" | "stage";
/** stage: base + 2 дрейфуючі радіальні свічення + сітка + зерно + віньєтка. */
glow?: [string, string];   // дефолт [primary, secondary]
grid?: boolean;            // дефолт true
tint?: string;             // колір, у який «кімната» перефарбовується (напр. palette.danger)
tintAmount?: number;       // 0..1, функція від кадру задається сценою

// packages/motion-kit/src/theme.tsx — Theme.palette має danger | warning | success завжди (не null),
// Theme.fonts.mono: string завжди (fallback — системний monospace).

// packages/motion-kit/src/media/Logo.tsx
export function useLogoGeometry(): { viewBox: string; paths: string[] } | null;
export function LogoPath(props: { draw?: number; stroke?: string; strokeWidth?: number; size: number }): JSX.Element;
```

### 2.7 Експорти `@adc/director` для стадії `author` — `packages/director/src/index.ts`

Додати реекспорт (без зміни реалізацій): `guardScene`, `formatViolations` (guard.ts), `typecheckScenes`
(typecheck.ts), `collectAutoIssues`, `rebuildSheets`, `versionStripSheet`, `STRIP_STEP` (stages/check.ts),
`loadCodegenContext`, `contextVars` (context.ts), `brandForCode` (stages/codegen.ts), `writeScenesIndex` (job.ts),
`parseFileBlocks` (files.ts).

### Тести Кроку 0

`pnpm --filter @adc/shared test` (схеми парсять старі фікстури; `Tuning` читає нові env; мок `agent`).
Плюс `pnpm typecheck` — нові поля `StageParamsMap`/`StageOutputsMap` компілюються у всіх пакетах, скелет
`@adc/author` збирається, реєстр воркера бачить заглушку `author` (єдиний дотик до воркера в Кроці 0).

## 3. Блоки робіт

### Хвиля 1 (усі паралельно після Кроку 0)

#### A1: Зведення — рівні, спільний простір, музичний дакінг
- Володіє: `packages/audio/src/mixer.ts`, `packages/audio/src/automation.ts`, `packages/audio/src/dsp.ts`,
  нові `packages/audio/src/reverb.ts`, `packages/audio/src/eq.ts`; тести `packages/audio/test/mixer.test.ts`,
  нові `packages/audio/test/reverb.test.ts`, `packages/audio/test/eq.test.ts`.
- Залежить від: Крок 0 (нічого нового в схемах; `SoundtrackInput` не змінюється).
- Критерії приймання:
  - музика нормалізується до `MASTER_RMS_DBFS` (−14) **до** додавання подій; сума не перенормовується, лише
    м'який кліпер з потолком −1 dBFS; `MIX_VERSION` = 3;
  - `CUE_LEVEL_DB`: impact/slam +5, riser +2, whoosh/swoosh 0, pop/ding/shimmer −2, tick/click −4 (над RMS
    музики у вікні); `ACCENT_DB.hard` = +3, `soft` = −3; `MAX_WINDOW_BOOST` = 1.5;
  - шина подій: HPF 80 Гц, LPF 9 кГц (`eq.ts`, Biquad), посил у спільний реверб (`reverb.ts`: детермінований
    експоненційний IR 1.2 с, предзатримка 10 мс, FFT-згортка) з рівнем `wet` 0.25 для подій і 0.08 для
    музики; результат побайтно детермінований;
  - дакінг музичний: на impact/slam замість експоненти 150 мс — HPF 150 Гц на музиці рівно на одну долю
    (`beatFrames(bpm)`) з рампою 5 мс на вході і 1/4 долі на виході; riser — HPF музики, що відкривається
    від 300 Гц до 20 Гц протягом тривалості riser і закінчується на кадрі події;
  - у `Soundtrack.stems` додається `reverb: StereoPcm`;
  - тест на проєкті-фікстурі: RMS музики в міксі ≥ −16 dBFS у секундах без подій; пік подій ≤ +6 дБ над RMS
    музики; `soundtrackHash` змінюється при зміні `MIX_VERSION`.
- Тести: `pnpm --filter @adc/audio test -- test/mixer.test.ts test/reverb.test.ts test/eq.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A2: Музика — один `compose`, запас довжини, перевірка треку
- Володіє: `packages/audio/src/music.ts`, `packages/audio/src/plan.ts`, `packages/audio/src/chunks.ts`,
  `packages/audio/src/constants.ts`, новий `packages/audio/src/trackCheck.ts`, `prompts/audio-plan.md`;
  тести `packages/audio/test/music.test.ts`, `plan.test.ts`, `chunks.test.ts`, новий `trackCheck.test.ts`.
- Залежить від: Крок 0 (`MusicTrackCheck`, `MusicMeta.check/attempts`).
- Критерії приймання:
  - `computeChunkLayout` повертає один чанк на весь трек; `trackMs = videoMs + 8000`; `normalizeAudioPlan`
    завжди пише один чанк (старі багаточанкові плани читаються, але не відтворюються);
  - `generateMusic`: спершу `compose` з `promptFallback` (єдиний промпт), `composeDetailed` — лише як
    фолбек на відхилений промпт; промпт `audio-plan.md` переписується: один абзац-опис, явні «no breakdown,
    no fill, no stop in the first N seconds», тактова структура (4/4, фрази по 4 такти);
  - `trackCheck.ts`: `checkTrack(pcm, bpm): MusicTrackCheck` — онсети бочки (переюз `lowBandOnsets` з
    `beat.ts`, read-only імпорт), RMS по секундах, провали > 1 с з падінням > 6 дБ від медіани; `ok` = є
    ≥ 0.8 онсета на долю і нема провалів у перших `videoMs`;
  - `ensureMusic`: після генерації — перевірка; `ok=false` → до 2 повторних генерацій (нові `attempts`),
    далі береться найкраща (найменше провалів) і вибирається вікно `videoMs` без провалів у межах `trackMs`
    (зсув вікна кратний такту; зсув передається у `MusicMeta` як `offsetMs`, поле додається тут, адитивно);
  - у `music.json` зберігається `check` і `attempts`; витрати всіх спроб пишуться в `costs.jsonl`.
- Тести: `pnpm --filter @adc/audio test -- test/music.test.ts test/plan.test.ts test/chunks.test.ts test/trackCheck.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1. `stage.ts` аудіо не чіпає: `offsetMs` застосовується
  у `renderSoundtrack`? Ні — щоб не перетинатися з A1, A2 застосовує зсув у `ensureMusic` (повертає вже
  обрізаний PCM через `decode` + `shiftPcm`-подібну утиліту у власному `trackCheck.ts`) і пише обрізаний
  `music.mp3`→`music.wav`. `PUBLIC_MUSIC_FILE` у `constants.ts` стає `music.wav`.

#### A3: Щільність ударів у нормалізації розкадровки
- Володіє: `packages/director/src/normalize.ts` (секція подій: `placeEvents`, `GRID_CUES`, нова
  `limitHits`), тест `packages/director/test/normalize.test.ts`.
- Залежить від: Крок 0 (нічого нового).
- Критерії приймання:
  - у всьому ролику не більше `1 + floor(totalSec / 6)` подій з cue `impact`/`slam` (24 с → 5); зайві,
    починаючи з найменш важливих (accent `soft` → `normal`, далі за порядком), понижуються до `pop`
    (`normal`) зі збереженням кадру; зміни пишуться в `changes`;
  - не більше 1 `impact`/`slam` у вікні 3 с; другий у вікні понижується так само;
  - `riser` не довший за 2 такти до події (нічого не змінюється, лише `changes`-попередження);
  - старі розкадровки з `sfxCue` обробляються як раніше.
- Тести: `pnpm --filter @adc/director test -- test/normalize.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### B1: Краулер — глибше і повніше
- Володіє: `packages/crawler/src/discovery.ts`, `packages/crawler/src/crawl.ts`, `packages/crawler/src/inpage.ts`,
  `packages/crawler/src/inpage/*`; тести `packages/crawler/test/discovery.test.ts`, `crawl.test.ts`,
  `extract.test.ts`, фікстури `packages/crawler/test/fixtures/*`.
- Залежить від: нічого (схема `SiteData` не змінюється).
- Критерії приймання:
  - `selectPages` пріоритезує за ключовими словами URL/anchor у мові сайту і en: how-it-works, features,
    pricing, faq, examples/demo/sample/report, cases, compare, about; блог — лише якщо лишився ліміт;
    `CRAWL_LIMITS.maxPages` лишається 25, `timeBudgetMs` без змін;
  - in-page: перед витягом тексту розкриваються `details`, `[aria-expanded=false]`, елементи з класами
    `accordion|collapse|faq|tab` (клік через Playwright, ліміт 40 кліків на сторінку); текст блоків
    склеюється з роздільниками (абзаци — порожній рядок, inline — пробіл), таблиці — `cell | cell`;
  - демо-дані, відрендерені в DOM (мок звіту на лендингу: картки проблем, оцінки, рядки плану), потрапляють
    у `PageData.text` як окремі рядки з префіксом `>` (цитата), щоб B2 їх побачив;
  - на фікстурі `tests/integration/fixtures/site` + нова фікстура з акордеоном: усі приховані відповіді є в тексті.
- Тести: `pnpm --filter @adc/crawler test`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### B2: Бренд-кіт — «речовина продукту» і семантика
- Володіє: `prompts/brandkit.md`, `prompts/brandkit-patch.md` (тільки згадка нових полів), новий
  `packages/brandkit/src/substance.ts`, `packages/brandkit/src/color.ts`, `packages/brandkit/src/fonts.ts`,
  `packages/brandkit/src/fonts.json`, `packages/brandkit/src/stage.ts`, `packages/brandkit/src/finalize.ts`;
  тести `packages/brandkit/test/*` (+ новий `substance.test.ts`).
- Залежить від: Крок 0 (`ProductSubstance`, `Palette.danger/warning/success`, `Typography.mono`).
- Критерії приймання:
  - промпт `brandkit.md` вимагає заповнити `substance` з тексту сайту: кроки, категорії перевірки,
    2–4 приклади результату з серйозністю/оцінкою/поясненням, 3–6 рядків плану з групою й оцінкою, продукти,
    порівняння; усе — дослівними цитатами; інструкція про семантичні кольори (з сайту, якщо є: червоний
    помилок, зелений успіху) і моношрифт (якщо сайт його використовує);
  - `verifySubstance(substance, siteText)` у `substance.ts`: рядок без дослівного збігу (нормалізація:
    пробіли, регістр, лапки, тире) викидається; звіт у `fixes`;
  - `color.ts`: `deriveSemanticPalette(palette)` — якщо `danger/warning/success` null, виводяться з
    фіксованих базових (`#EF4444`, `#F59E0B`, `#22C55E`), підмішаних до `accent` на 15 % і перевірених на
    контраст ≥ 3 до `background` і `surface` (підсвітлення/затемнення кроком 5 % до проходження);
  - `fonts.ts`: `mono` null → `JetBrains Mono` з `fonts.json` (додати запис з кирилицею), якщо шрифт
    бренду сам моно — він;
  - `finalize.ts` викликає обидва; `facts.ts` не чіпається (A/B конфліктів нема).
- Тести: `pnpm --filter @adc/brandkit test`
- Паралельність: одночасно з усіма блоками хвилі 1 (B1 не потрібен: працює з будь-яким текстом).

#### B3: Розкадровка — продукт у кадрі, нові ролі, звукова дисципліна
- Володіє: `prompts/storyboard.md`, `prompts/storyboard-copyfix.md`, `prompts/revise.md` (лише перелік
  ролей), `packages/director/src/stages/storyboard.ts` (змінні промпта: `substance`, `semantic`), тести
  `packages/director/test/storyboard-copyfix.test.ts`, `storyboard-revise.test.ts`, нова фікстура
  `packages/director/test/fixtures/storyboard-substance.json`.
- Залежить від: Крок 0 (`OnScreenRole` eyebrow/status, `BrandKit.substance`).
- Критерії приймання:
  - у `<brand>` для сценарію додається `substance`; промпт: «продукт у роботі» — обов'язкові сцени
    «що перевіряє» (з `checks`) і «приклад результату» (з `exampleIssues`/`planRows`) незалежно від
    відповідей власника; відповіді — акцент (яка сцена довша, що в CTA), а не заміна демонстрації;
  - кожен UI-мок несе реальні рядки: список/картка — 3–4 `item` + `status`/`badge` на рядок, `eyebrow` над
    блоком; промпт показує приклад сцени з 8–12 items; `copyRules` не змінюються;
  - звукова дисципліна в промпті: 2–3 структурних удари на ролик (хук, кульмінація, фінал), решта — pop/tick/
    ding; обов'язковий `breakdown` у `structure` перед фінальною сценою; межі сцен — на тактах (4 долі);
    `durationFrames` кратні `4 × beatFrames` (нормалізація вже округлює до долі; тут — вимога до моделі);
  - кольорова драматургія: сцена `problem` або приклад проблеми просить `tint` фону в `danger` (у
    `motionIntent`), «план/результат» повертає базовий колір;
  - `durationRule` без змін.
- Тести: `pnpm --filter @adc/director test -- test/storyboard-copyfix.test.ts test/storyboard-revise.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### B4: Motion-kit — живий фон, семантична тема, геометрія лого
- Володіє: `packages/motion-kit/src/media/Backdrop.tsx`, `packages/motion-kit/src/media/Logo.tsx`,
  `packages/motion-kit/src/theme.tsx`, `packages/motion-kit/src/fonts.ts`, `packages/motion-kit/src/index.ts`,
  `packages/motion-kit/API.md`, `packages/motion-kit/scripts/*` (генерація `API.generated.md`),
  `packages/motion-kit/examples/typographic.tsx` (показати `stage` і `LogoPath`); тести
  `packages/motion-kit/test/*`.
- Залежить від: Крок 0 (§2.6 імена; `Palette`/`Typography` нові поля).
- Критерії приймання:
  - `Backdrop variant="stage"`: два радіальні свічення, що дрейфують за синусами від кадру (детерміновано),
    сітка 96 px з маскою до центру й дрейфом 0.4 px/кадр, зерно `feTurbulence` з `seed = frame % 9`,
    віньєтка; `tint`/`tintAmount` перефарбовують свічення; для QA повідомляє базовий колір (`BG_ATTR`);
  - `Theme.palette.danger/warning/success` завжди рядки (беруться з бренд-кіта, який після B2 завжди їх має;
    для старих бренд-кітів — ті самі базові кольори, що в B2, продубльовані в `theme.tsx` як fallback);
    `Theme.fonts.mono` — завантажується як heading/body (`fonts.ts`), fallback `ui-monospace, monospace`;
  - `useLogoGeometry()`: читає SVG лого з `AssetsProvider` (тип `svg`), повертає `viewBox` і масив `d`
    шляхів (polyline/polygon/rect/circle конвертуються в path; `<text>` і растр — null); `LogoPath`
    малює шляхи з `strokeDasharray`/`draw` 0..1 через `@remotion/paths`; растрове лого → `null`, сцена
    має фолбек на `<Logo>`;
  - `API.md` описує нові речі; `API.generated.md` перегенеровано.
- Тести: `pnpm --filter @adc/motion-kit test`
- Паралельність: одночасно з усіма блоками хвилі 1 (B5 пише промпти проти імен з §2.6, не чекаючи B4).

#### B5: Промпти коду й арт-директора
- Володіє: `prompts/codegen.md`, `prompts/code-fix.md`, `prompts/qa.md`, `prompts/motion-reference.md`,
  `packages/director/src/context.ts` (змінна `logoGeometryHint`: чи лого векторне), `packages/director/src/stages/qa.ts`
  (нові `kind` у виводі не потрібні — `QaIssueKind` уже має `placeholder`, `off_brief`, `too_much_text`;
  додається правило-рубрика); тести `packages/director/test/codegen.test.ts`, `codegen-film.test.ts`, `qa.test.ts`.
- Залежить від: Крок 0 (§2.6 імена, ролі `eyebrow`/`status`).
- Критерії приймання:
  - `codegen.md`: правило 7 доповнено семантичними кольорами й `mix`-відтінками; описано `Backdrop stage`
    як дефолтний фон фільму і `tint` для проблемних сцен; `theme.fonts.mono` для чисел/eyebrow/status;
    `useLogoGeometry`/`LogoPath` для фіналу, коли лого векторне; нове правило «макет»: дві сусідні сцени
    не можуть мати однаковий контейнер на тій самій позиції без видимої трансформації між ними; items з
    ролями `eyebrow`/`status` обов'язково в кадрі, якщо є в сцені;
  - `code-fix.md`: ті самі правила;
  - `qa.md`: додається розділ «Showreel bar» — після дефектів QA ставить сцені 4 оцінки 1–5 (розмаїття
    макету відносно сусідів, життя фону, заповненість моків реальними рядками, кольорова драматургія);
    оцінка ≤ 2 → `issue` kind `off_brief` (макет/фон) або `placeholder` (мок) severity `major` з конкретним
    `fix`; `summary` згадує загальний бал; `QaReport` схема не змінюється (оцінки лише в `description`);
  - `motion-reference.md` без змістових змін (перелік прикладів оновлюється автоматично з `examples/`).
- Тести: `pnpm --filter @adc/director test -- test/codegen.test.ts test/codegen-film.test.ts test/qa.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### D1: Eval-кейс паритету
- Володіє: `eval/sites.json`, `scripts/eval.ts`, `tests/integration/src/eval.ts`, `tests/integration/src/harness.ts`
  (лише параметри сценарію), `docs/analysis/README.md` (новий: як порівнювати).
- Залежить від: нічого.
- Критерії приймання:
  - у `eval/sites.json` кейс `webreportio-parity`: `https://webreportio.com/`, формат `landscape`, мова `uk`,
    без відповідей власника, тривалість 25; у `scripts/eval.ts` прапорець `--mode pipeline|agent`
    (передає `ADC_GENERATION_MODE` у воркер eval) і звіт: $ і хвилини зі `costs.jsonl`/`trace.jsonl`, RMS
    музики/подій зі `stems` (A1) і `MusicTrackCheck` (A2) у `eval/out/<case>/report.json`;
  - у `docs/analysis/README.md` — процедура порівняння з `one line.mp4` (контакт-листи 1 fps, аудіо-метрики
    зі скрипта в `scripts/eval.ts`).
- Тести: `pnpm --filter @adc/integration test -- test/eval.test.ts` (моки стадій, без LIVE).
- Паралельність: одночасно з усіма блоками хвилі 1.

### Хвиля 2 (після злиття хвилі 1; C1 і C2 паралельно між собою)

#### C1: Пакет `@adc/author` — агент, що пише, рендерить і дивиться
- Володіє: пакет `packages/author/**` (скелет з Кроку 0: `src/stage.ts`, `src/tools/*.ts`, `src/budget.ts`,
  `src/index.ts`, `test/*`, залежності у власному `package.json`), `prompts/author.md`,
  `packages/shared/src/llm/agent.ts` (реалізація заглушки з Кроку 0; `client.ts` не чіпається),
  `packages/shared/test/llm-agent.test.ts`.
- Залежить від: Крок 0 (§2.4, §2.5, §2.7), хвиля 1 (нові промпти/кіт стають контекстом агента).
- Критерії приймання:
  - `authorStage: Stage<"author">` робить те, що codegen+check+qa+fix, одним циклом: system = `author.md`
    (бриф «showreel, go all out» + ті самі жорсткі правила, що в `codegen.md`, посиланням на той самий
    `motion-reference` префікс для кешу), user = brand/assets/storyboard/instructions; інструменти:
    - `write_scene({ sceneId, code })` → guard (`guardScene`) + typecheck (`typecheckScenes`) → текст
      помилок або `ok`; пише версію в journal (`addVersion`, origin `author`);
    - `render_strip({ sceneId, format })` → стрип 0.5 с (`rebuildSheets`/`versionStripSheet` через
      `RenderEngine`) → зображення + `autoIssues` текстом;
    - `render_frames({ sceneId, frames: number[], format })` → до 6 стілів;
    - `contact_sheet({ format })` → усі сцени по 4 кадри на один аркуш (для «фільмового» погляду);
    - `audio_events()` → таблиця подій зі звуком у секундах (read-only з розкадровки);
    - `finish({ summary })` → завершення;
  - бюджет (`budget.ts`): зупинка за `authorTokenBudget`, `authorMaxIterations`, `authorMaxMinutes`; при
    зупинці без `finish` — сцени без коду/з guard-помилками йдуть у `missing`, як у codegen (далі `check` →
    `fix` як зараз);
  - кожен виклик інструмента логуються в `director/author/log.jsonl` (ітерація, інструмент, вхід без коду,
    $, токени); рендери рахуються в `costs.jsonl` як `remotion.perRender`;
  - `StageOutputs.author` заповнюється; артефакти — ті самі ключі, що в codegen (`video/scenes/*.tsx`,
    `director/scenes.json`, `director/versions/**`), тож check/qa/render далі працюють без змін;
  - `agent.ts`: tool loop на `messages.create` зі стрімом, `cache_control` на system і на визначенні
    інструментів, повтори транспортних помилок як у `text()`, запис `CostEvent` на кожну ітерацію
    (`detail: "author:iter:<n>"`), `stoppedBy`.
- Тести: `pnpm --filter @adc/author test` (мок `Llm.agent` зі сценарієм: 2 сцени, одна guard-помилка,
  один стрип, finish) і `pnpm --filter @adc/shared test -- test/llm-agent.test.ts` (новий тест з
  `createMockAnthropic`).
- Паралельність: одночасно з C2.

#### C2: Підключення `author` до пайплайна і воркера
- Володіє: `packages/pipeline/src/machine.ts` (функції `startDirecting`, `onCodegenDone` → узагальнення
  `onAuthorDone`), `packages/pipeline/src/driver.ts` (реєстрація обробника `author`), `apps/worker/src/env.ts`
  (документація нових env), `README.md` (розділ перемикачів), тести `packages/pipeline/test/*`,
  `apps/worker/test/*`. `apps/worker/src/stages.ts` уже реєструє `author` з Кроку 0 — не чіпається.
- Залежить від: Крок 0; для інтеграційного тесту — мок `Stage<"author">` (C1 не потрібен для злиття).
- Критерії приймання:
  - `Tuning.generationMode === "agent"` → `startDirecting` ставить `author` замість `codegen` (ті самі
    `sceneIds`/`instructions`); після `author` — `check` зі `sceneIds = outputs.sceneIds`, далі як зараз
    (QA лишається як страховка; `qaMaxRounds` для agent-режиму дефолтно 1 — у `machine.ts` через `ctx`);
  - правки після стілів/видачі в agent-режимі теж ідуть через `author` (subset);
  - `pipeline` режим не змінюється побайтно (тест: той самий сценарій подій дає ту саму послідовність джобів);
  - `README.md`: `ADC_GENERATION_MODE`, бюджети, вартість.
- Тести: `pnpm --filter @adc/pipeline test` і `pnpm --filter @adc/worker test`
- Паралельність: одночасно з C1.

## 4. Карта володіння файлами

- Крок 0 → `packages/shared/src/schemas/brandkit.ts`, `storyboard.ts`, `audioPlan.ts`, `project.ts`,
  `packages/shared/src/stage.ts`, `queue.ts`, `tuning.ts`, `packages/shared/src/llm/client.ts` (інтерфейс),
  `packages/shared/src/llm/mock.ts`, `packages/shared/src/llm/agent.ts` (заглушка), `packages/shared/test/*`,
  `packages/director/src/index.ts`, скелет `packages/author/{package.json,src/index.ts}`,
  `apps/worker/src/stages.ts` (реєстрація `author`), `pnpm-lock.yaml`.
- A1 → `packages/audio/src/{mixer,automation,dsp,reverb,eq}.ts`, `packages/audio/test/{mixer,reverb,eq}.test.ts`
- A2 → `packages/audio/src/{music,plan,chunks,constants,trackCheck}.ts`, `prompts/audio-plan.md`,
  `packages/audio/test/{music,plan,chunks,trackCheck}.test.ts`
- A3 → `packages/director/src/normalize.ts`, `packages/director/test/normalize.test.ts`
- B1 → `packages/crawler/src/{discovery,crawl,inpage}.ts`, `packages/crawler/src/inpage/**`, `packages/crawler/test/**`
- B2 → `prompts/brandkit.md`, `prompts/brandkit-patch.md`, `packages/brandkit/src/{substance,color,fonts,stage,finalize}.ts`,
  `packages/brandkit/src/fonts.json`, `packages/brandkit/test/**`
- B3 → `prompts/storyboard.md`, `prompts/storyboard-copyfix.md`, `prompts/revise.md`,
  `packages/director/src/stages/storyboard.ts`, `packages/director/test/{storyboard-copyfix,storyboard-revise}.test.ts`,
  `packages/director/test/fixtures/storyboard-substance.json`
- B4 → `packages/motion-kit/src/media/{Backdrop,Logo}.tsx`, `packages/motion-kit/src/{theme,fonts,index}.ts(x)`,
  `packages/motion-kit/API.md`, `API.generated.md`, `packages/motion-kit/scripts/**`, `examples/typographic.tsx`,
  `packages/motion-kit/test/**`
- B5 → `prompts/{codegen,code-fix,qa,motion-reference}.md`, `packages/director/src/context.ts`,
  `packages/director/src/stages/qa.ts`, `packages/director/test/{codegen,codegen-film,qa}.test.ts`
- D1 → `eval/sites.json`, `scripts/eval.ts`, `tests/integration/src/{eval,harness}.ts`, `docs/analysis/README.md`
- C1 → `packages/author/**` (крім скелета з Кроку 0 — його C1 лише наповнює), `prompts/author.md`,
  `packages/shared/src/llm/agent.ts`, `packages/shared/test/llm-agent.test.ts`
- C2 → `packages/pipeline/src/{machine,driver}.ts`, `packages/pipeline/test/**`, `apps/worker/src/env.ts`,
  `apps/worker/test/**`, `README.md`
- Спільні (один власник!):
  - `packages/audio/src/stage.ts` → нікому в хвилі 1 (A1 і A2 не чіпають; `offsetMs` застосовує A2 всередині
    `ensureMusic`); якщо знадобиться — окремий міні-PR після злиття A1+A2;
  - `packages/audio/src/beat.ts`, `samples.ts`, `pcm.ts` → read-only для всіх (імпорт без змін);
  - `packages/director/src/guard.ts`, `claims.ts`, `ledger.ts`, `stages/codegen.ts`, `stages/check.ts`,
    `stages/fix.ts` → read-only для хвилі 1 і C1 (C1 імпортує через `index.ts` з Кроку 0);
  - `prompts/elevenlabs/sfx-cues.md` → не чіпається (зміна тексту = нові платні SFX);
  - `package.json` (корінь), `pnpm-lock.yaml` → лише Крок 0 (скелет `@adc/author`) і C1 (залежності
    тільки у `packages/author/package.json`; lockfile оновлюється в PR C1 останнім перед злиттям);
  - `apps/worker/src/stages.ts` → лише Крок 0;
  - `packages/shared/src/llm/client.ts` → лише Крок 0.

## 5. Спільні ресурси й ізоляція

Worktree ізолює файли, але не Redis, порти, `DATA_DIR` і ключі API.

- **Redis:** кожному worktree свій індекс БД у `.env.local`: `REDIS_URL=redis://localhost:6379/<n>` (A1 — 1,
  A2 — 2, … C2 — 11). Юніт-тести Redis не потребують (`ioredis-mock`).
- **`DATA_DIR`:** дефолт `./.data` відносно кореня worktree — уже ізольовано; кеш SFX `DATA_DIR/cache/sfx`
  у кожному worktree свій, LIVE-генерацію SFX не запускати (`pnpm sfx-cache` — лише власник).
- **Порти:** `PORT` у `.env.local` (3001…3011) для тих, хто піднімає API локально (C2, D1).
- **Ключі Anthropic/ElevenLabs:** лише у власника; усі тести блоків — з моками (`createMockAnthropic`,
  `fakeSfx.ts`, мок `RenderEngine` з `packages/director/test/strip-engine.ts`). `LIVE=1` не запускати в
  блоках; живий прогін — етап L.
- **Браузери Playwright/Chromium:** B1 і рендер-тести використовують встановлені браузери; паралельні
  worktree ділять кеш `~/.cache/ms-playwright` — це читання, конфліктів нема.
- **Шрифти:** B4 і B2 додають `JetBrains Mono` незалежно (B2 — запис у `fonts.json` бренд-кіта, B4 —
  завантаження через `planFont`); імена шрифту узгоджені: `"JetBrains Mono"`.

## 6. План інтеграції

- Інтеграційна гілка: `claude/showreel-parity` від `main` після злиття Кроку 0.
- Порядок злиття хвилі 1: A3 → A1 → A2 → B4 → B2 → B1 → B3 → B5 → D1 (спершу ті, від чиїх імен залежать
  промпти; промпти — останніми, щоб їхні тести бачили реальний кіт).
- Після кожного merge у `claude/showreel-parity` — решта гілок хвилі робить `git merge claude/showreel-parity`
  (через `sync_with_base_branch` у Desktop), щоб конфлікти спливали рано.
- Після злиття хвилі 1: `pnpm --filter @adc/audio test && pnpm --filter @adc/director test && pnpm --filter @adc/crawler test && pnpm --filter @adc/brandkit test && pnpm --filter @adc/motion-kit test && pnpm --filter @adc/integration test`
  + `pnpm smoke`. Повний прогін — ні.
- Хвиля 2: C2 → C1 (C2 тестується з моком `Stage<"author">`; C1 наповнює скелет пакета, реєстр воркера
  вже вказує на нього з Кроку 0, тому порядок злиття не створює конфліктів).
- Після злиття хвилі 2: `pnpm --filter @adc/author test && pnpm --filter @adc/pipeline test && pnpm --filter @adc/worker test && pnpm --filter @adc/shared test` + `pnpm smoke`.
- Етап L (власник, LIVE): `pnpm eval -- --case webreportio-parity --mode pipeline`, потім `--mode agent`;
  порівняння з `one line.mp4` за `docs/analysis/README.md`; $ і хвилини — у таблицю в цьому ТЗ.
- Злиття `claude/showreel-parity` → `main` одним PR після зеленого фінального прогону (§7).

## 7. Правила тестування

Повний прогін робиться **один раз — наприкінці всього ТЗ**, перед злиттям у `main`.

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | Лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | `pnpm --filter @adc/shared test` + `pnpm typecheck` + `pnpm smoke` | Ні |
| Після злиття хвилі 1 | Команда з §6 для хвилі 1 + `pnpm smoke` | Ні |
| Після злиття хвилі 2 | Команда з §6 для хвилі 2 + `pnpm smoke` | Ні |
| Блок змінив спільний файл (`packages/shared/**`, `packages/director/src/index.ts`, `apps/worker/src/stages.ts`) | Тести блоку + тести пакетів, що напряму імпортують змінене: `@adc/director`, `@adc/audio`, `@adc/pipeline`, `@adc/worker` | Ні |
| **Фінал — усе злито в `claude/showreel-parity`** | **`pnpm test` + `pnpm lint` + `pnpm typecheck`** | **Так, один раз** |

Правила для агента (дослівно в кожну сесію):
- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на `main` до
  змін; якщо падало — не чіпай, лише зафіксуй у звіті.»
- «Фінальний прогін — це ворота перед злиттям у `main`: поки він не зелений, ТЗ не вважається виконаним.»
- «`LIVE=1`, `pnpm sfx-cache`, `pnpm eval` без `--mock` — лише власник, лише на етапі L.»

## 8. Review і Definition of Done

**На блок:** тести блоку зелені; `pnpm lint` чистий на змінених файлах (`biome check <files>`); `pnpm typecheck`
зелений у пакеті блоку; жодних правок поза файлами з карти володіння (перевірка: `git diff --name-only main`);
PR з маленьким зрозумілим diff; у промптах — хеш у frontmatter не чіпається (його рахує код).

**На ТЗ:** фінальний `pnpm test` + `pnpm lint` + `pnpm typecheck` зелені (або падіння підтверджено як наявні
на `main`); етап L пройдено: кейс `webreportio-parity` у режимі `agent` видає ролик, у якому за
`docs/analysis/README.md` виконано: музика в міксі ≥ −16 dBFS поза подіями, піки подій ≤ +6 дБ над музикою,
`MusicTrackCheck.ok = true`, у розкадровці ≤ 5 impact/slam, у кадрі є категорії перевірки і приклад
результату з реальними рядками, фон живий у кожній сцені, жодні дві сусідні сцени не повторюють макет;
фактичні $ і хвилини обох режимів записано в таблицю нижче.

| Режим | $ | хв | Токени | Примітка |
|---|---|---|---|---|
| pipeline (до ТЗ, 9LDzhp…) | 3.96 | 26 | ≈0.8 M | базова лінія |
| pipeline (після хвилі 1) | | | | |
| agent (після хвилі 2) | | | | |

## 9. Команди запуску в Claude Code

- **Просто (рекомендовано):** окрема сесія Desktop на кожен блок — кожна отримує свій worktree. Стеля —
  4 паралельні сесії (напр. A1+A2+B1+B4, потім A3+B2+B3+B5, потім D1; хвиля 2 — C1+C2).
- **CLI:** `claude -w parity-a1`, у другому терміналі `claude -w parity-a2` тощо.
- **Субагенти в одній сесії:** `isolation: worktree` у frontmatter `.claude/agents/*.md` або «use worktrees
  for your agents».
- У кожному worktree: `corepack pnpm install`, свій `.env.local` (`REDIS_URL` індекс, `PORT`), без ключів API.
- Тримати `main` чистим; усе гілкується від `claude/showreel-parity` (після Кроку 0); після merge —
  `git worktree remove`.
