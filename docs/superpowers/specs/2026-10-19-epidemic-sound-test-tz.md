# ТЗ: тест Epidemic Sound (музика і SFX) поруч з ElevenLabs

Дата: 2026-10-19. Дизайн: [`2026-10-19-epidemic-sound-test-design.md`](2026-10-19-epidemic-sound-test-design.md)
(рішення власника §2, §9; рішення виконавця §7). Формат — parallel-ready: Крок 0 заморожує перемикачі,
схеми, інтерфейс клієнта Epidemic і сигнатури функцій провайдерів, далі блоки без спільних файлів.

Передумови: хвиля «звукорежисер + рецензент» у `main` (PR #38); `ELEVENLABS_API_KEY` і кеш SFX
ElevenLabs прогріті; у власника є ключ Epidemic Sound (`epidemic_live_…`, безкоштовний тариф, 50
завантажень).

## 1. Мета і контекст

Музику і SFX сьогодні генерує лише ElevenLabs (`packages/audio`): `ensureMusic` у `music.ts`,
`ensureStandardSfx`/`ensureCustomSfx` у `sfx.ts`, усе зшито в `createAudioStage` (`stage.ts`). Абстракції
провайдера немає, `provider: "elevenlabs"` зашито в записах витрат.

Треба, щоб власник на слух порівняв каталог Epidemic Sound із генерацією ElevenLabs на чотирьох роликах
(два сайти × дві комбінації, картинка в межах сайту однакова):

| Комбінація | Музика | SFX |
|---|---|---|
| A | Epidemic Sound | ElevenLabs |
| B | ElevenLabs | Epidemic Sound |

Epidemic **не генерує**: «режим Epidemic» — це пошук готового треку чи семплу в каталозі за текстом,
підгонка треку під тривалість (бета `POST /v0/tracks/versions`) і завантаження. Два незалежні
перемикачі `ADC_MUSIC_PROVIDER` і `ADC_SFX_PROVIDER` (дефолт `elevenlabs`), увесь пайплайн через
`pnpm eval`, квота 50 завантажень не перевищується (локальний лічильник зупиняє прогін на 45).

**Незмінне (анти-цілі дизайну §3):** без нових env усе поводиться як сьогодні — жоден хеш кешу ElevenLabs
(`musicPlanHash`, `sfxHash`, `soundtrackHash`) не змінюється, наявні тести лишаються зеленими;
`renderSoundtrack`, `MIX_VERSION`, `checkTrack`, `sfxQc`, мікшер і розкадровка не змінюються; ролики з
Epidemic-звуком нікуди публічно не йдуть (`eval/runs/` у `.gitignore`).

**Факти про API (developers.epidemicsound.com, OpenAPI `/docs/spec.json`, перевірено 2026-10-19):**

- База `https://api.epidemicsound.com`; API-ключ іде напряму `Authorization: Bearer <ключ>`, без обміну
  на токени (`/v0/partner-token` і `/v0/token` — deprecated, для ключа не потрібні).
- `GET /v0/tracks/search`: `term` (≤ 500 симв., семантичний), `bpmMin`/`bpmMax` (включно),
  `vocalType=NONE`, `genre`/`mood` (повторювані ключі, id з `GET /v0/tracks/parameters`), `sort`
  (`Relevance|BPM|Duration|…`), `order`, `limit` ≤ 60, `offset`. Трек: `id`, `title`, `mainArtists`,
  `bpm`, `length` (с), `moods[]`, `genres[]`, `hasVocals`, `vocalType`, `isPreviewOnly` (не надійний).
- `GET /v0/tracks/{trackId}/download?format=mp3&quality=normal|high` → `{ url, expires }` (normal 128 кбіт/с,
  посилання 24 год; high 320 кбіт/с, 1 год). **Кожен виклик — завантаження.**
- `POST /v0/tracks/versions` `{ trackId, durationMs }` (1 000–300 000) → `{ jobId, status }`;
  `GET /v0/tracks/versions/{jobId}` → `status` (`PENDING` → `COMPLETED`; інші значення в довідці не
  показані — трактувати все, що не `PENDING`/`COMPLETED`, як збій), `results.highQualityUrl`,
  `results.previewUrl` (живуть 24 год). Бета.
- `GET /v0/sound-effects/search`: `term` (обов'язковий), `sort` (`best-match|length|…`), `order`, `limit`
  ≤ 60, `offset`. Семпл: `id`, `title`, `length` (с). Фільтрів тривалості немає — лише на клієнті.
- `GET /v0/sound-effects/{trackId}/download?quality=normal` → `{ url, expires }`.
- 429 на всіх ендпоінтах без заголовків ліміту; ліміт частоти — на користувача.
- Безкоштовний план: увесь каталог, усі ендпоінти, **50 завантажень**, без комерційної ліцензії.

## 2. Крок 0 — заморожені інтерфейси (робиться першим, окремим PR у `main`)

Усі зміни схем адитивні з дефолтами: старі `music.json`, `audio.json`, `pipeline.json`, `costs.jsonl`
парсяться. Поки Крок 0 не влитий, паралель не стартує. Власник Кроку 0 далі веде всі міні-PR у
`packages/shared` і в `packages/audio/src/provider.ts`.

### 2.1 Перемикачі — `packages/shared/src/tuning.ts`, `.env.example`

```ts
export const AudioProvider = z.enum(["elevenlabs", "epidemic"]);
export type AudioProvider = z.infer<typeof AudioProvider>;
// Tuning:
musicProvider: AudioProvider.default("elevenlabs"),   // ADC_MUSIC_PROVIDER
sfxProvider: AudioProvider.default("elevenlabs"),     // ADC_SFX_PROVIDER
```

`TUNING_ENV` + обидва ключі. Валідація як у решти: невалідне значення → `TuningError` (воркер падає на
старті, `eval` — код 2 до старту). `.env.example`: `EPIDEMIC_API_KEY=` з коментарем «ключ Partner API
(`epidemic_live_…`), безкоштовний тариф — 50 завантажень, лише прототип». `AudioProvider` експортується з
`@adc/shared` (`index.ts`).

### 2.2 Схеми — `packages/shared/src/schemas/audioPlan.ts`, `types/video.ts`, `cost.ts`

`MusicMeta` (адитивно):

```ts
provider: AudioProvider.default("elevenlabs"),
method: z.enum(["composeDetailed", "compose", "catalog"]),      // catalog — трек з каталогу Epidemic
/** Лише provider=epidemic. */
epidemic: z.object({
  trackId: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  /** Темп треку за каталогом і темп розкадровки, під який його підібрано. */
  bpm: z.number().nullable(),
  targetBpm: z.number(),
  /** Темп кандидата поза допуском ±10 — узято найближчий (попередження у звіт). */
  tempoWarning: z.boolean(),
  versionJobId: z.string().nullable(),
  /** Скільки кандидатів перевірено (1 — перший пройшов checkTrack). */
  candidatesTried: z.number().int().min(1),
}).nullable().default(null),
```

`AudioManifest` (`types/video.ts`, адитивно):

```ts
providers: z.object({ music: AudioProvider, sfx: AudioProvider })
  .default({ music: "elevenlabs", sfx: "elevenlabs" }),
/** Що взято з Epidemic у цій ревізії (для звіту eval); null — Epidemic не використовувався. */
epidemic: z.object({
  trackId: z.string().nullable(),
  sfx: z.array(z.object({ cue: z.string(), variant: z.number().int(), id: z.string(), title: z.string() })),
  /** Завантажень Epidemic, витрачених цією стадією (не з кешу). */
  downloads: z.number().int().min(0),
}).nullable().default(null),
```

Витрати (`schemas/cost.ts`, `cost/ledger.ts`): `Provider` + `"epidemic"`; `CostInput` — новий варіант
`{ provider: "epidemic"; kind: "music" | "sfx"; model: string; seconds: number }`; `priceEpidemic` → `usd: 0`,
`unitPrices: {}`, `units: { seconds }`, `exact: true` (безкоштовний тариф; `config/prices.json` не
змінюється — ціни Epidemic немає, і `Prices` лишається як є). `stats.ts` і `/stats` групують за
`provider` рядком — нічого робити.

### 2.3 Параметри стадії — `packages/shared/src/stage.ts`, `packages/pipeline/src/pipe.ts`

```ts
// StageParamsMap
audio: { phase?: "music" | "mix" | "full"; musicProvider?: AudioProvider; sfxProvider?: AudioProvider };
// Відсутнє поле = readTuning() у стадії (старі job і тести — як сьогодні).
// PipeState (адитивно, фіксується на старті ревізії як sfxMode):
musicProvider: AudioProvider.default("elevenlabs"),
sfxProvider: AudioProvider.default("elevenlabs"),
```

`pipe.ts` належить пакету `pipeline`, але схема потрібна і B5 (машина), і B6 (eval `prepareRerun`) — тому
поле додається в Кроці 0, логіка — у блоках.

### 2.4 Інтерфейс Epidemic і сигнатури провайдерів — `packages/audio/src/provider.ts` (новий)

```ts
import type { AudioProvider } from "@adc/shared";

/** Мінімальний клієнт Partner API; справжній — HTTP (B1), у тестах — mockEpidemic(). */
export interface EpidemicTrack {
  id: string; title: string; mainArtists: string[]; bpm: number | null; length: number;
  moods: Array<{ id: string; name: string }>; genres: Array<{ id: string; name: string }>;
  hasVocals: boolean;
}
export interface EpidemicSoundEffect { id: string; title: string; length: number }
export interface EpidemicRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface EpidemicLike {
  searchTracks(q: {
    term: string; bpmMin?: number; bpmMax?: number; vocalType?: Array<"NONE" | "PRESENCE" | "LEAD">;
    sort?: "Relevance" | "BPM" | "Duration" | "Popularity"; order?: "asc" | "desc"; limit?: number; offset?: number;
  }, o?: EpidemicRequestOptions): Promise<{ tracks: EpidemicTrack[] }>;
  trackDownloadUrl(trackId: string, q: { quality: "normal" | "high" }, o?: EpidemicRequestOptions):
    Promise<{ url: string; expires: string }>;
  startVersion(body: { trackId: string; durationMs: number }, o?: EpidemicRequestOptions):
    Promise<{ jobId: string; status: string }>;
  versionStatus(jobId: string, o?: EpidemicRequestOptions):
    Promise<{ status: string; results?: { previewUrl?: string; highQualityUrl?: string } | null; message?: string }>;
  searchSoundEffects(q: {
    term: string; sort?: "best-match" | "length" | "popular"; order?: "asc" | "desc"; limit?: number; offset?: number;
  }, o?: EpidemicRequestOptions): Promise<{ soundEffects: EpidemicSoundEffect[] }>;
  soundEffectDownloadUrl(id: string, q: { quality: "normal" | "high" }, o?: EpidemicRequestOptions):
    Promise<{ url: string; expires: string }>;
  /** Байти за підписаним URL (не рахується клієнтом — рахує квота). */
  fetchBytes(url: string, o?: EpidemicRequestOptions): Promise<Buffer>;
}

/** Класифікація помилок Epidemic (як classifyElevenLabsError): для черги й зрозумілих StageError. */
export type EpidemicErrorKind = "unauthorized" | "rate_limited" | "not_found" | "server" | "network" | "aborted" | "quota" | "other";
export class EpidemicError extends Error { kind: EpidemicErrorKind; status: number | null; }

/** Локальний лічильник завантажень (поза DATA_DIR прогону). */
export const EPIDEMIC_DOWNLOAD_LIMIT = 50;
export const EPIDEMIC_DOWNLOAD_SOFT_LIMIT = 45;
export type EpidemicDownloadKind = "track" | "version" | "version_fetch" | "sfx";
export interface EpidemicQuota {
  /** Поточне значення лічильника. */
  used(): Promise<number>;
  /**
   * Перед платним кроком: якщо used() ≥ EPIDEMIC_DOWNLOAD_SOFT_LIMIT — EpidemicError kind "quota"
   * (стадія перетворює на StageError "epidemic_quota", не retryable). Інакше інкремент + рядок журналу.
   */
  consume(kind: EpidemicDownloadKind, id: string, detail?: string): Promise<number>;
}

/** Усе, що потрібно провайдеру Epidemic понад MusicDeps/SfxDeps. */
export interface EpidemicDeps {
  client: () => EpidemicLike;                 // ліниво: без ключа падає лише при реальному виклику
  quota: EpidemicQuota;
  /** Постійний кеш завантажень (ADC_EPIDEMIC_DIR), не DATA_DIR прогону. */
  cache: Storage;
  gate: EpidemicGate;                         // клас у epidemic/gate.ts (B1); тут — тип
  logger?: Logger;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Музика: та сама форма результату, що в ensureMusic (music.ts). */
export type EnsureMusicFn = (
  deps: MusicDeps & { epidemic: EpidemicDeps; llm: StageContext<"audio">["llm"]; targetBpm: number },
  projectId: string, plan: AudioPlan, briefHash: string,
) => Promise<EnsuredMusic>;

/** SFX: які варіанти реально прозвучать — вирішує стадія (B4) і просить лише їх. */
export interface SfxVariantRequest { cue: string; variant: number; def: CueDefinition; custom: boolean }
export type EnsureSfxVariantsFn = (
  deps: SfxDeps & { epidemic: EpidemicDeps; cost: CostRecorder; projectId: string },
  requests: readonly SfxVariantRequest[],
) => Promise<Array<{ cue: string; variant: number; file: SfxFile; epidemicId: string; title: string }>>;
```

У Кроці 0 поруч лежать **заглушки з цими сигнатурами**, які блоки потім наповнюють (файл створює Крок 0,
володіє блок):

- `packages/audio/src/epidemic/client.ts`: `createEpidemicClient(apiKey = process.env.EPIDEMIC_API_KEY, fetchImpl = fetch): EpidemicLike` — кидає `EpidemicError("unauthorized")`, якщо ключа немає; методи — `throw new Error("not implemented")`.
- `packages/audio/src/epidemic/quota.ts`: `createEpidemicQuota(dir: string): EpidemicQuota`, `epidemicDir(env = process.env): string` — заглушки.
- `packages/audio/src/epidemic/gate.ts`: `export class EpidemicGate { run<T>(label, fn, signal?): Promise<T> }` — поки просто викликає `fn`
  (`provider.ts` імпортує з нього лише тип).
- `packages/audio/src/epidemic/errors.ts`: `export function classifyEpidemicError(err: unknown): { kind: EpidemicErrorKind; status: number | null }` — поки повертає `other`.
- `packages/audio/src/music.ts` — один рядок: `EnsuredMusic.downloads?: number` (завантажень Epidemic, витрачених цим викликом; ElevenLabs не ставить).
- `packages/audio/src/variants.ts` — сигнатура для стадії (B4 викликає її напряму):
  `export function variantIndices(placements: readonly EventPlacement[], poolSize: (cue: SoundCue) => number): Array<{ cue: SoundCue; variant: number }>`
  (`variant` 1-based); у Кроці 0 — проста ротація по колу без `PER_SCENE_CUES`; точна логіка і `chooseVariants` через неї — B3.
- Формат файлу лічильника (читає і B1, і звіт B6): `EPIDEMIC_DOWNLOADS_FILE = "downloads.json"`,
  `{ version: 1, used: number, events: Array<{ ts: string; kind: EpidemicDownloadKind; id: string; detail: string | null }> }` —
  zod-схема `EpidemicDownloadsFile` у `provider.ts`.
- `packages/audio/src/epidemic/music.ts`: `export const ensureEpidemicMusic: EnsureMusicFn` — кидає `not implemented`.
- `packages/audio/src/epidemic/sfx.ts`: `export const ensureEpidemicSfxVariants: EnsureSfxVariantsFn` — кидає `not implemented`.
- `packages/audio/src/index.ts`: реекспорт `provider.ts` і `epidemic/*`.
- `packages/audio/test/epidemicHelpers.ts`: `mockEpidemic(fixtures?)` — мок `EpidemicLike` з чергами відповідей
  на кожен метод і журналом `calls` (за зразком `mockElevenLabs` у `helpers.ts`), `memoryQuota(start = 0)` —
  `EpidemicQuota` в пам'яті з журналом `consumed`. Обидва потрібні B2, B3, B4 — тому створює Крок 0.
- `prompts/epidemic/music-pick.md` — лише валідний frontmatter (`model: claude-sonnet-5-5`, `effort: low`,
  `max_tokens: 2000`, `cache: false`, `description: "Epidemic: вибір треку серед кандидатів пошуку за метаданими"`)
  і рядок-плейсхолдер, щоб `prompts.test.ts` був зелений; тіло пише B2.
- `prompts/epidemic/sfx-terms.md` — лише frontmatter з тими самими полями, що в `elevenlabs/sfx-cues.md`
  (`description: "Epidemic: пошукові фрази для 30 cue (не LLM-виклик)"`); тіло пише B3.

### 2.5 Тести Кроку 0

Нові/оновлені: `packages/shared/test/tuning.test.ts` (обидва перемикачі: дефолт, валідні, невалідне →
`TuningError` з іменем env), `packages/shared/test/schemas.test.ts` (старий `music.json` без `provider` →
`elevenlabs`; `audio.json` без `providers`/`epidemic`; `pipeline.json` без провайдерів), `packages/shared/test/cost.test.ts`
(`provider: "epidemic"` → `usd 0`, рядок валідний за `CostEvent`), `packages/audio/test/epidemicHelpers.test.ts`
(мок віддає черги, квота рахує).

```bash
pnpm typecheck
pnpm --filter @adc/shared exec vitest run test/tuning.test.ts test/schemas.test.ts test/cost.test.ts test/prompts.test.ts
pnpm --filter @adc/audio exec vitest run test/epidemicHelpers.test.ts
pnpm smoke
```

## 3. Блоки робіт (хвиля 1, усі паралельно після Кроку 0)

### B1: Клієнт Epidemic, квота, черга, live-smoke

- **Володіє:** `packages/audio/src/epidemic/client.ts`, `packages/audio/src/epidemic/quota.ts`,
  `packages/audio/src/epidemic/gate.ts`, `packages/audio/src/epidemic/errors.ts` (новий: `classifyEpidemicError`),
  новий `packages/audio/live/epidemic.ts` + скрипт `live:epidemic` у `packages/audio/package.json`,
  тести `packages/audio/test/epidemic-client.test.ts`, `epidemic-quota.test.ts`, `epidemic-gate.test.ts`.
- **Залежить від:** Крок 0 (`provider.ts`). Нічого з B2–B6.
- **Поведінка:**
  - **Клієнт** — `fetch` (Node 22), без SDK і без нових залежностей. База `https://api.epidemicsound.com`
    (перевизначення `EPIDEMIC_API_BASE` для тестів/проксі), `Authorization: Bearer <EPIDEMIC_API_KEY>`,
    `Accept: application/json`. Повторювані query-ключі (`vocalType=NONE&vocalType=…`) через `URLSearchParams.append`.
    Таймаут за `o.timeoutMs` (дефолт 30 с, `fetchBytes` — 120 с) через `AbortSignal.any([signal, timeout])`.
    Відповіді валідуються zod-схемами мінімально (потрібні поля; зайві ігноруються). Помилки:
    401/403 → `unauthorized`, 404 → `not_found`, 429 → `rate_limited`, 5xx → `server`, `TypeError`/abort → `network`/`aborted`.
    `fetchBytes` — GET підписаного URL **без** заголовка Authorization (URL уже підписаний), повертає `Buffer`.
  - **Квота** — `epidemicDir(env)`: `ADC_EPIDEMIC_DIR`, інакше `<корінь репо>/.data/epidemic` (через
    `findRepoRoot()`, **не** `DATA_DIR`: у eval він свій на кожен прогін — пастка §6.1 дизайну).
    `createEpidemicQuota(dir)`: файл `<dir>/downloads.json` за схемою `EpidemicDownloadsFile` з Кроку 0;
    запис атомарний (tmp + rename); `consume` читає файл щоразу (один eval-процес, досить).
    `consume` при `used ≥ 45` кидає `EpidemicError` kind `quota` з текстом «Epidemic: витрачено N з 50
    завантажень, поріг 45 — прогін зупинено» і **не інкрементує**. `EPIDEMIC_QUOTA_OVERRIDE=1` — ні, такого
    прапорця не робити (анти-ціль «квоту витрачено на повтори»).
  - **Черга** — `EpidemicGate` за зразком `ElevenLabsGate`: `maxConcurrent` 2 (`EPIDEMIC_CONCURRENCY`),
    повтор лише на `rate_limited`/`server`/`network` (до 5, експоненційно 2–30 с, `sleep` ін'єктується),
    `unauthorized`/`not_found`/`quota` — одразу назовні. Спільний екземпляр процесу `defaultEpidemicGate(logger)`.
  - **Live-smoke** `LIVE=1 pnpm --filter @adc/audio live:epidemic`: пошук треків (`term` + bpm 90±6,
    `vocalType=NONE`) і SFX (`whoosh`) **без завантажень**, друк перших 5 результатів і значення лічильника;
    з прапорцем `--download-one` — одне завантаження SFX normal через квоту (це єдиний платний крок; у блоках
    не запускати). Без `LIVE=1` — пояснення і вихід 0.
- **Критерії приймання:** клієнт формує правильні URL/заголовки (перевірено через ін'єктований `fetch`);
  429 повторюється чергою, 401 — ні; квота: 44 → ok (стає 45), 45 → помилка без інкременту, файл
  переживає новий екземпляр; `epidemicDir` не залежить від `DATA_DIR`.
- **Тести:** `pnpm --filter @adc/audio exec vitest run test/epidemic-client.test.ts test/epidemic-quota.test.ts test/epidemic-gate.test.ts`
- **Паралельність:** одночасно з B2–B6.

### B2: Музика з Epidemic — пошук, вибір LLM, Create versions, той самий `checkTrack`

- **Володіє:** `packages/audio/src/epidemic/music.ts` (заглушка з Кроку 0), `packages/audio/src/music.ts`
  (рефакторинг: спільний хвіст `ensureMusic` виноситься в експортовану функцію — див. нижче),
  `packages/audio/src/plan.ts` (лише додати `musicPlanHashFor(provider, plan)`; `musicPlanHash` для
  `elevenlabs` лишається побайтно тим самим), `prompts/epidemic/music-pick.md`, тести
  `packages/audio/test/music.test.ts`, новий `packages/audio/test/epidemic-music.test.ts`.
- **Залежить від:** Крок 0 (`EnsureMusicFn`, `EpidemicDeps`, `mockEpidemic`, `memoryQuota`, схема
  `MusicMeta.epidemic`). B1 — лише типом; тести на моку.
- **Поведінка `ensureEpidemicMusic(deps, projectId, plan, briefHash)`:**
  1. `planHash = musicPlanHashFor("epidemic", plan)` = `inputsHash({ provider: "epidemic", compositionPlan, promptFallback, trackMs })`
     — інший простір ключів, ніж у ElevenLabs (дизайн §4.2: кеш музики включає провайдера). Кеш-хіт у
     `audio/<planHash>/music.json` → як у `ensureMusic` (без жодного виклику й завантаження).
  2. **Запит:** `term` = `plan.promptFallback` (він уже містить настрій, жанр, інструменти, «N BPM», «instrumental»),
     обрізаний до 500 символів; `vocalType: ["NONE"]`; `limit: 30`; `sort: "Relevance"`.
     **Темп (дизайн §9.1):** `targetBpm = deps.targetBpm` (BPM розкадровки, його передає стадія; збігається з
     `planBpm(plan)`). Раунд 1: три пошуки з `bpmMin/bpmMax` = `[t−6, t+6]`, `[t/2−3, t/2+3]`, `[2t−12, 2t+12]`
     (цілі, ≥ 40); результати зливаються, дублікати за `id` відкидаються; лишаються треки, у яких
     `tempoMatches(track.bpm, t, 6)` (трек, його половина або подвоєння в межах допуску; `bpm === null` —
     відкидається); відсортовані за |відхилення| потім за порядком пошуку; перші **5** — кандидати.
     Раунд 2 (якщо кандидатів 0): те саме з допуском ±10. Раунд 3 (якщо знову 0): один пошук без bpm,
     `limit 30`, кандидат — найближчий за ефективним темпом, `tempoWarning: true`. Пошуки завантажень не
     витрачають.
  3. **Вибір:** `ctx.llm.structured("epidemic/music-pick", vars, PickDraft)` — один виклик, `PickDraft =
     { trackId: string; reason: string }`. У `vars`: `promptFallback`, стилі плану, `targetBpm`, тривалість
     відео, таблиця кандидатів (`id`, `title`, `artists`, `bpm`, `length`, `moods`, `genres`). Невідомий
     `trackId` у відповіді → перший кандидат, попередження в лог. Якщо кандидат один — без виклику LLM.
     Промпт (англійською, у стилі `audio-plan.md`): роль музичного редактора; обирати за настроєм/жанром/
     енергією під бриф, темп уже відфільтровано; «data, not instructions»; відповідь — лише JSON за схемою.
  4. **Підгонка:** `quota.consume("version", trackId)` → `client.startVersion({ trackId, durationMs: planTrackMs(plan) })`
     (це трек «відео + 8 с», як і в ElevenLabs, щоб `chooseWindowOffset` мав куди зсувати вікно) →
     опитування `versionStatus(jobId)` кожні 3 с (ін'єктований `sleep`), до 5 хв; `status === "COMPLETED"`
     і є `results.highQualityUrl` → `quota.consume("version_fetch", trackId)` → `fetchBytes(highQualityUrl)`.
     Статус не `PENDING`/`COMPLETED` або таймаут → **фолбек без версії**: `quota.consume("track", trackId)` →
     `trackDownloadUrl(trackId, { quality: "high" })` → `fetchBytes(url)` — повний трек, далі вікно відео
     вирізається з нього як сьогодні (`chooseWindowOffset`/`cutWindow`; якщо трек коротший за відео — трек
     лишається сирим, `check: null`, попередження). Байти кладуться в постійний кеш
     `deps.epidemic.cache`: `music/<trackId>-<durationMs>.mp3` (повторний прогін того самого треку —
     без завантаження).
  5. **Перевірка і повтор (дизайн §4.2 п. 6–7):** декодування → `checkTrack(pcm, targetBpm, { videoMs })`.
     `ok=false` → **один** повтор із наступним кандидатом (кроки 4–5), далі `betterCheck` обирає кращого з
     двох. Повторний виклик LLM не робиться — беремо наступного за списком з кроку 2.
  6. **Запис** — той самий хвіст, що в `ensureMusic`: сирий у `audio/<planHash>/music.mp3`, вікно → `music.wav`,
     `music.json` з `provider: "epidemic"`, `method: "catalog"`, `modelId: "epidemic-catalog"`, `promptUsed: term`,
     `briefHash`, `attempts: candidatesTried`, `epidemic: {…}`. Витрати: `cost.record({ provider: "epidemic", kind: "music", model: "epidemic-catalog", seconds: durationMs/1000, detail: "music:epidemic:<trackId>" })`
     на кожне завантаження (usd 0 — але рядок у `costs.jsonl` потрібен звіту).
  - **Рефакторинг `music.ts`:** хвіст `ensureMusic` після циклу спроб (вибір `best`, `chooseWindowOffset`,
    `cutWindow`, повторний `checkTrack`, запис файлів і `music.json`) виноситься в
    `export async function finalizeMusic(deps, projectId, planHash, best: Attempt, base: Omit<MusicMeta, "durationMs"|"check"|"offsetMs">, bpm, videoMs): Promise<EnsuredMusic>`;
    `ensureMusic` викликає його, `ensureEpidemicMusic` — теж. Поведінка ElevenLabs не змінюється — усі тести
    `music.test.ts` зелені без правок очікувань (можна додавати, не міняти).
- **Критерії приймання:** на моку: фільтр темпу з половиною/подвоєнням; раунди ±6 → ±10 → найближчий з
  `tempoWarning`; LLM-вибір і фолбек на першого; версія → один `version` + один `version_fetch` у квоті;
  збій версії → `track`; `ok=false` → рівно один другий кандидат; кеш-хіт — нуль викликів і нуль
  `consume`; `musicPlanHash` ElevenLabs не змінився (тест із зафіксованим хешем фікстури);
  квота 45 → `EpidemicError quota` до будь-якого мережевого завантаження.
- **Тести:** `pnpm --filter @adc/audio exec vitest run test/music.test.ts test/epidemic-music.test.ts test/plan.test.ts`
- **Паралельність:** одночасно з B1, B3–B6.

### B3: SFX з Epidemic — пошук за cue, лише потрібні варіанти, QC, обрізання

- **Володіє:** `packages/audio/src/epidemic/sfx.ts` (заглушка з Кроку 0), `prompts/epidemic/sfx-terms.md`,
  `packages/audio/src/variants.ts` (лише винести чисту функцію ротації — див. нижче), тести
  новий `packages/audio/test/epidemic-sfx.test.ts`, `packages/audio/test/variants.test.ts`.
- **Залежить від:** Крок 0 (`EnsureSfxVariantsFn`, `SfxVariantRequest`, моки). `defaultSfxQc` з `sfxQc.ts`,
  `decodeAudio`, `encodeWav`, `fitLength` — лише імпортом.
- **Поведінка `ensureEpidemicSfxVariants(deps, requests)`:**
  - **Пошукова фраза.** `prompts/epidemic/sfx-terms.md` — 30 рядків `- <cue>: <коротка англійська фраза>`
    (наприклад `- whoosh: fast clean air whoosh transition`, `- pop: short soft bubble pop`), розбір як у
    `parseCueLines` (своя проста регулярка в `epidemic/sfx.ts`); відсутній cue — помилка завантаження файлу
    (тест на всі `SoundCue.options`). Для кастомних cue (`custom: true`) фраза = `def.text`, обрізаний до
    першої коми або 120 символів (тексти ElevenLabs довгі й містять технічні вимоги, які каталогу не потрібні).
  - **Один пошук на cue** (дизайн §4.3): `searchSoundEffects({ term, sort: "best-match", limit: 30 })`,
    результат кешується в `cache: sfx/search/<hash(term)>.json` (детермінізм між прогонами, пошуки не
    рахуються, але повторювати їх нема сенсу). Кандидати впорядковуються: спершу ті, у кого
    `length ≤ max(2 × def.durationSeconds, 1.5)`, усередині — за порядком best-match. **Варіант `k`** =
    `k`-й кандидат (індекс `(k−1) mod n`); якщо `n === 0` — cue без семплів (стадія логує, подія німіє —
    як сьогодні при порожньому cue).
  - **Завантаження** лише за `requests` (стадія вже вирахувала, що прозвучить — B4): для кожного
    `(cue, variant)` → кандидат → постійний кеш `sfx/<id>.mp3` + `sfx/<id>.json` (`{ id, title, length, cue, term, qc }`).
    Промах → `quota.consume("sfx", id, "<cue>.<k>")` → `soundEffectDownloadUrl(id, { quality: "normal" })` →
    `fetchBytes` → у кеш. Витрати: `cost.record({ provider: "epidemic", kind: "sfx", model: "epidemic-catalog", seconds: length, detail: "sfx:<cue>.<k>:<id>" })`.
  - **QC і повтор:** декодування → обрізання до `def.durationSeconds` (якщо довший) з лінійним fade-out
    30 мс наприкінці, обрізання тиші на початку робити не треба (мікшер уже обрізає onset) → `encodeWav` →
    `deps.qc(wav, cue, def)`; `ok=false` → **один** повтор наступним невикористаним кандидатом; лишається
    кращий з двох (менше `reasons`), подія не німіє (дизайн §4.3). Результат QC — у `sfx/<id>.json`.
  - **Файл для стадії:** готовий WAV копіюється у сховище проєкту `audio/epidemic-sfx/<id>.wav`
    (`projectPaths(projectId).audioDir`), і це `SfxFile.key`; `SfxFile.hash = "ep-" + id`, `durationMs` —
    фактичний, `generated` = чи було завантаження, `qcOk`. Так `produceMix` у стадії читає семпли з того
    самого `storage`, що й сьогодні, а `soundtrackHash` бачить інші хеші семплів → інше зведення.
  - **Ротація (`variants.ts`):** із `chooseVariants` виноситься чиста
    `export function variantIndices(placements, poolSize: (cue) => number): Array<{ cue; variant: number /* 1-based */ }>`
    з тією самою логікою лічильників і `PER_SCENE_CUES`; `chooseVariants` реалізується через неї
    (для `variantPool` тональних cue — як зараз, по відфільтрованому пулу). Існуючі тести `variants.test.ts`
    без змін очікувань. Для Epidemic стадія (B4) викликає `variantIndices(placements, () => 5)` — тональна
    фільтрація за висотою для каталожних семплів не робиться (у каталозі висота не гарантована; QC
    тональних cue все одно проходить — `reasons` лише зменшують пріоритет).
- **Критерії приймання:** на моку: один `searchSoundEffects` на cue навіть для 3 варіантів; завантажуються
  лише запитані варіанти; другий виклик з тим самим `(cue, variant)` — нуль `consume`; QC-провал → рівно
  один повтор, кращий лишається; файл довший за cue обрізано до cue + fade; `sfx-terms.md` покриває всі
  `SoundCue.options`; квота 45 → помилка до завантаження; `prompts/elevenlabs/sfx-cues.md` і `sfxHash`
  не чіпаються.
- **Тести:** `pnpm --filter @adc/audio exec vitest run test/epidemic-sfx.test.ts test/variants.test.ts`
- **Паралельність:** одночасно з B1, B2, B4–B6.

### B4: Стадія `audio` — перемикання провайдерів, правило перевикористання, маніфест

- **Володіє:** `packages/audio/src/stage.ts`, `packages/audio/src/manifest.ts` (адитивно: `providers`,
  `epidemic` у `ManifestInput`), тести `packages/audio/test/stage.test.ts`, новий
  `packages/audio/test/stage-epidemic.test.ts`.
- **Залежить від:** Крок 0 (параметри `audio`, `EnsureMusicFn`/`EnsureSfxVariantsFn`, `AudioManifest`,
  `MusicMeta.provider`). B2/B3 — лише типами: `AudioStageDeps` отримує точки підміни, тести B4 підставляють
  фейкові функції, а не реальні `ensureEpidemic*`.
- **Поведінка:**
  - `AudioStageDeps` (адитивно): `epidemicClient?: EpidemicLike | (() => EpidemicLike)`, `epidemicQuota?: EpidemicQuota`,
    `epidemicCache?: Storage`, `epidemicGate?: EpidemicGate`, `ensureMusicBy?: Partial<Record<AudioProvider, EnsureMusicFn>>`,
    `ensureSfxVariantsBy?: Partial<Record<"epidemic", EnsureSfxVariantsFn>>`. Дефолти: `createEpidemicClient()`
    ліниво (без ключа → `StageError("epidemic_not_configured", "Сервіс Epidemic Sound не налаштовано.", retryable=false)`),
    `createEpidemicQuota(epidemicDir())`, `new LocalStorage(epidemicDir())`, `defaultEpidemicGate(logger)`,
    `ensureEpidemicMusic`, `ensureEpidemicSfxVariants`.
  - Провайдери: `musicProvider = ctx.params.musicProvider ?? readTuning().musicProvider`, так само `sfxProvider`.
    Лог на старті стадії: `{ phase, musicProvider, sfxProvider }`.
  - **Музика.** `canReuseMusic(prev, briefHash, videoMs, provider)` — додатковий аргумент: `prev.provider === provider`
    (старі `music.json` без поля — `elevenlabs`). Це закриває пастку §6.1 «перевикористання треку»: прогін 2
    з іншим провайдером не підхопить трек прогону 1 ні через `project.audioPlanHash`, ні через `audio.json`
    основи. Планування (`audio-plan`) не змінюється: план потрібен і Epidemic (бриф → `term`, `targetBpm`,
    `trackMs`). `targetBpm = draft.musicBrief.bpm` (BPM розкадровки; `planBpm(plan)` з ним збігається після
    `withBriefTempo`). Для `epidemic` викликається `ensureMusicBy.epidemic({ ...musicDeps, epidemic, llm: ctx.llm, targetBpm }, …)`;
    помилки → `StageError("music_failed")` як зараз, але `EpidemicError kind quota` → `StageError("epidemic_quota", повідомлення квоти, retryable=false)`,
    `unauthorized` → `epidemic_not_configured`.
  - **SFX у фазах (пастки §6.1 «прогрів» і «усі 5 варіантів»):** при `sfxProvider === "epidemic"`:
    - фаза `music`: **без** прогріву бібліотеки (`ensureVariants` не викликається взагалі; у ElevenLabs — як
      сьогодні, уся бібліотека);
    - фази `mix`/`full`: `placements = computeEventPlacements(storyboard)` (ефективна розкадровка з планом
      SFX), `variantIndices(placements, () => 5)` → унікальні `(cue, variant)` → `SfxVariantRequest[]` з
      `def = sfxLibrary[cue][variant−1]` → `ensureSfxVariantsBy.epidemic(...)` → `VariantFile[]` для
      `produceMix` (без `dropFailedQc` — провайдер уже лишив кращий із двох). Legacy `scene.sfxCue`
      (стандартні cue, варіант 1) і кастомні cue плану (`custom: true`, `def = { text: spec.text, durationSeconds }`)
      — через ту саму функцію, у `public/sfx/` копіюються як сьогодні.
    - Результат: у маніфест `epidemic.sfx[]` і `epidemic.downloads` = кількість семплів із `generated === true`
      + `EnsuredMusic.downloads ?? 0` (поле додає Крок 0, заповнює B2).
    - Виклик: `ensureSfxVariantsBy.epidemic({ ...sfxDeps, epidemic, cost: ctx.cost, projectId }, requests)`.
  - **Витрати:** `provider` у викликах `cost.record` стадії вже йде з модулів провайдерів; у `stage.ts`
    власних записів немає — перевірити, що немає зашитого `"elevenlabs"` поза `music.ts`/`sfx.ts` (сьогодні
    немає).
  - **Маніфест:** `buildAudioManifest` додає `providers: { music, sfx }` і `epidemic` (null, якщо обидва
    `elevenlabs`). `outputs` стадії не змінюються.
- **Критерії приймання:** без параметрів і без env — усі наявні тести `stage.test.ts` зелені без правок
  очікувань (хеші, виклики, файли ті самі); `musicProvider: "epidemic"` → виклик фейкової `ensureMusicBy.epidemic`
  з `targetBpm` розкадровки, ElevenLabs-клієнт не створюється; `sfxProvider: "epidemic"` у фазі `music` —
  нуль викликів SFX; у `mix` — запити лише на варіанти, які повертає `variantIndices` (тест з 2 сценами ×
  `pop`, де perScene дає 2 варіанти, а не 5); перевикористання: `music.json` з `provider: "epidemic"` при
  `musicProvider: "elevenlabs"` → новий трек, і навпаки; без `EPIDEMIC_API_KEY` з `epidemic` → `epidemic_not_configured`
  до будь-якого виклику; `audio.json` має `providers`/`epidemic`.
- **Тести:** `pnpm --filter @adc/audio exec vitest run test/stage.test.ts test/stage-epidemic.test.ts`
- **Паралельність:** одночасно з B1–B3, B5, B6.

### B5: Оркестрація — провайдери фіксуються на ревізію

- **Володіє:** `packages/pipeline/src/machine.ts`, `packages/pipeline/src/driver.ts` (`StepContext.tuning`
  + `musicProvider`, `sfxProvider`, як `sfxMode`), тести `packages/pipeline/test/machine.test.ts`,
  `packages/pipeline/test/helpers.ts` (опція tuning у хелпері).
- **Залежить від:** Крок 0 (`PipeState.musicProvider/sfxProvider`, параметри `audio`).
- **Поведінка:** `startDirecting` читає `d.ctx.musicProvider ?? readTuning().musicProvider` (і sfx), пише в
  `d.pipe`, і **кожен** `enqueue("audio", …)` у машині (`startDirecting`, `maybeMix`) передає
  `{ phase, musicProvider: d.pipe.musicProvider, sfxProvider: d.pipe.sfxProvider }`. Між `music` і `mix`
  зміна env провайдера не діє (зафіксовано в `pipe`). Старі `pipeline.json` без полів → `elevenlabs`.
- **Критерії приймання:** тести машини: `audio{music}` і `audio{mix}` однієї ревізії несуть ті самі
  провайдери, навіть якщо `ctx` між кроками змінився; дефолт без tuning — `elevenlabs`/`elevenlabs`;
  існуючі тести машини зелені (параметри `audio` порівнювати через `toMatchObject`, якщо вони звіряють
  точний об'єкт — оновити очікування додаванням полів, не зміною логіки). Споживачі машини поза пакетом
  (`integration/test/pipeline.test.ts`, `eval-run.test.ts`) ганяються лише на інтеграції (розділ 7), у
  блоці їх не чіпати: вони читають `pipeline.json`, а нові поля мають дефолти.
- **Тести:** `pnpm --filter @adc/pipeline exec vitest run test/machine.test.ts test/driver.test.ts`
- **Паралельність:** одночасно з B1–B4, B6.

### B6: Eval — перевірки до старту, перезапуск з провайдерами з env, звіт

- **Володіє:** `tests/integration/src/eval.ts`, `tests/integration/test/eval.test.ts`, новий
  `eval/sites.epidemic.json`, `eval/README.md`.
- **Залежить від:** Крок 0 (схеми `AudioManifest.providers/epidemic`, `MusicMeta.epidemic`, `PipeState`).
- **Поведінка:**
  - **До старту:** `readTuning()` уже валідує нові env (код 2). Додатково: якщо будь-який провайдер
    `epidemic` і немає `EPIDEMIC_API_KEY` → друк «eval: ADC_*_PROVIDER=epidemic потребує EPIDEMIC_API_KEY у
    кореневому .env» і код 2. Друк рядка «eval: провайдери music=…, sfx=…» поруч із рядком режиму звуку.
    `SoundTuning` розширюється полями `musicProvider`, `sfxProvider` (`currentSoundTuning`).
  - **`prepareRerun`** (пастки §6.1): приймає `providers: { music, sfx }` (дефолт із `currentSoundTuning()`),
    у `resetSound` пише `pipe.musicProvider/sfxProvider`, а всі `enqueue("audio", …)` передають їх у параметрах;
    для `--from audio` **скидає `project.audioPlanHash = null`** (трек вирішує `ensureMusic` за кешем
    `planHash`, а не «той, що був»; разом із правилом провайдера з B4 це гарантує, що прогін 2 не візьме
    трек прогону 1 іншого провайдера; при тому самому провайдері трек візьметься з кешу `audio/<planHash>/`
    безкоштовно).
  - **Звіт:** `SiteReport` + `audio: { musicProvider, sfxProvider, epidemic: { trackId, trackTitle, sfxCount, downloads, tempoWarning } | null }`
    з `audio.json` ревізії і `music.json` за `planHash`; `report.md` прогону і кейсу — колонки «Музика»,
    «SFX», «Epidemic: трек / семплів / завантажень», попередження темпу як «⚠ темп» у клітинці; у підсумку
    прогону — рядок «Завантажень Epidemic за прогін: N (лічильник: M з 50)» — лічильник читається з
    `downloads.json` за `EpidemicDownloadsFile` з Кроку 0 (функція `readEpidemicUsed(dir)` в `eval.ts`, тека —
    `epidemicDir()` зі заглушки Кроку 0; файлу немає → «—»).
  - **`eval/sites.epidemic.json`** (дизайн §9.2): `webreportio-parity` як у `sites.json` і
    `{ "url": "https://profitstore.ua/", "name": "profitstore", "formats": ["landscape"], "language": "uk", "durationSeconds": 25 }`.
  - `eval/README.md`: розділ «Тест Epidemic Sound» з двома командами прогону (розділ 10 нижче), квотою й
    приміткою про `ADC_EPIDEMIC_DIR`.
- **Критерії приймання:** `parseEvalArgs`/старт: невалідний `ADC_MUSIC_PROVIDER` → код 2 до ключів;
  `epidemic` без ключа → код 2; `prepareRerun("audio")` обнуляє `audioPlanHash` і ставить провайдери в
  `pipe` і в параметри job; звіт зі старими даними (без `providers`) показує `elevenlabs`/`elevenlabs` і «—»;
  `sites.epidemic.json` валідний за `loadSites`.
- **Тести:** `pnpm --filter @adc/integration exec vitest run test/eval.test.ts`
- **Паралельність:** одночасно з B1–B5.

## 4. Карта володіння файлами

| Блок | Файли |
|---|---|
| Крок 0 | `packages/shared/src/{tuning.ts,index.ts,stage.ts}`, `packages/shared/src/schemas/{audioPlan.ts,cost.ts}`, `packages/shared/src/types/video.ts`, `packages/shared/src/cost/ledger.ts`, `packages/shared/test/{tuning,schemas,cost}.test.ts`, `packages/pipeline/src/pipe.ts` (лише поля схеми), `packages/audio/src/provider.ts`, заглушки `packages/audio/src/epidemic/{client,quota,gate,errors,music,sfx}.ts`, `packages/audio/src/index.ts`, `packages/audio/test/epidemicHelpers.ts` (+ `.test.ts`), frontmatter `prompts/epidemic/{music-pick,sfx-terms}.md`, `.env.example`, одно-рядкові заготовки: `EnsuredMusic.downloads?` (`music.ts`), `variantIndices` (`variants.ts`) |
| B1 | `packages/audio/src/epidemic/{client,quota,gate,errors}.ts`, `packages/audio/live/epidemic.ts`, `packages/audio/package.json` (скрипт), `packages/audio/test/epidemic-{client,quota,gate}.test.ts` |
| B2 | `packages/audio/src/epidemic/music.ts`, `packages/audio/src/music.ts`, `packages/audio/src/plan.ts` (лише `musicPlanHashFor`), `prompts/epidemic/music-pick.md`, `packages/audio/test/{music,epidemic-music,plan}.test.ts` |
| B3 | `packages/audio/src/epidemic/sfx.ts`, `packages/audio/src/variants.ts`, `prompts/epidemic/sfx-terms.md`, `packages/audio/test/{epidemic-sfx,variants}.test.ts` |
| B4 | `packages/audio/src/stage.ts`, `packages/audio/src/manifest.ts`, `packages/audio/test/{stage,stage-epidemic}.test.ts` |
| B5 | `packages/pipeline/src/{machine,driver}.ts`, `packages/pipeline/test/{machine,driver,helpers}.ts` |
| B6 | `tests/integration/src/eval.ts`, `tests/integration/test/eval.test.ts`, `eval/sites.epidemic.json`, `eval/README.md` |
| Інтеграція | `README.md` (таблиця `ADC_*`, розділ «Тест Epidemic»), розділ 11 цього ТЗ |

Спільні файли — один власник: `packages/shared/**` і `provider.ts` → Крок 0 (після нього — лише міні-PR
власника Кроку 0, інші блоки не правлять); `packages/audio/src/sfx.ts`, `sfxCache.ts`, `mixer.ts`,
`trackCheck.ts`, `sfxQc.ts`, `samples.ts`, `constants.ts`, `client.ts`, `gate.ts`, `errors.ts` →
**ніхто в хвилі 1 не править** (B2–B4 імпортують); `packages/audio/test/helpers.ts` → ніхто не править
(нові хелпери — у `epidemicHelpers.ts` з Кроку 0); `prompts/elevenlabs/sfx-cues.md` → не чіпати;
`package.json`/`pnpm-lock.yaml` кореня → нових залежностей немає (клієнт на `fetch`); `README.md` → лише
інтеграційний PR; `packages/audio/package.json` → B1 (єдина правка — скрипт `live:epidemic`).

Перевірка перетинів: B2 (`music.ts`, `plan.ts`), B3 (`variants.ts`), B4 (`stage.ts`, `manifest.ts`) — різні
файли одного пакета; `stage.ts` викликає B2/B3 через сигнатури з `provider.ts` і в тестах підмінює їх
фейками, тож не чекає на них. B5 і B6 обидва пишуть `pipe.musicProvider` — поле з Кроку 0, файли різні.

## 5. Спільні ресурси й ізоляція

- **Квота Epidemic — єдиний спільний стан поза git, і worktree його не ізолює.** Лічильник і кеш
  завантажень живуть у `ADC_EPIDEMIC_DIR` (дефолт `<корінь checkout>/.data/epidemic`); у кожному worktree
  дефолт свій, тож **два live-прогони з різних checkout рахували б квоту окремо**. Правило: платні виклики
  Epidemic (`LIVE=1 pnpm eval` з `epidemic`, `live:epidemic --download-one`) робить лише власник, з одного
  checkout, після інтеграції; на час тесту виставити `ADC_EPIDEMIC_DIR` абсолютним шляхом у кореневому
  `.env`, щоб прогони 1 і 2 (і будь-який повтор) ділили один лічильник і один кеш семплів. У блоках —
  лише моки (`mockEpidemic`, `memoryQuota`, тимчасові теки через `mkdtemp`).
- **Сховище:** `DATA_DIR` у кожного worktree своє (`.data`); eval — своє на прогін. Кеш ElevenLabs
  (`cache/sfx`) не чіпається жодним блоком.
- **Redis/порт:** жоден блок не потребує живого воркера; eval-тести працюють у процесі (`createHarness`).
  Для ручних запусків — свій `REDIS_URL`/`PORT` у `.env.local` на worktree (README).
- **Платні API:** `LIVE=1`, ключі Anthropic/ElevenLabs/Epidemic — лише у власника на інтеграції. LLM у
  тестах — `createMockAnthropic`; ElevenLabs — `mockElevenLabs`/`fakeSfx`.
- **Промпти:** `prompts.test.ts` читає всі `.md` у `prompts/` — файли `prompts/epidemic/*` мають валідний
  frontmatter з першого коміту Кроку 0.

## 6. План інтеграції

- Інтеграційна гілка: `claude/epidemic-integration` від `main` після злиття Кроку 0.
- Порядок злиття хвилі 1: **B1 → B3 → B2 → B4 → B5 → B6** (спершу клієнт/квота, потім провайдери, потім
  стадія, що їх викликає, потім оркестрація і звіт). Після кожного merge решта гілок оновлюється від
  інтеграційної (`sync_with_base_branch`), щоб конфлікти спливали малими порціями.
- Після хвилі 1 (в інтеграційній гілці):
  ```bash
  pnpm typecheck
  pnpm lint
  pnpm --filter @adc/shared exec vitest run test/tuning.test.ts test/schemas.test.ts test/cost.test.ts test/prompts.test.ts
  pnpm --filter @adc/audio exec vitest run test/epidemic-client.test.ts test/epidemic-quota.test.ts test/epidemic-gate.test.ts test/epidemic-music.test.ts test/epidemic-sfx.test.ts test/music.test.ts test/variants.test.ts test/plan.test.ts test/stage.test.ts test/stage-epidemic.test.ts
  pnpm --filter @adc/pipeline exec vitest run test/machine.test.ts test/driver.test.ts
  pnpm --filter @adc/integration exec vitest run test/eval.test.ts
  pnpm smoke
  ```
- Інтеграційний PR у `main` додатково: README (два нові `ADC_*` у таблиці перемикачів, `EPIDEMIC_API_KEY`,
  абзац про квоту і `ADC_EPIDEMIC_DIR`), розділ 11 цього ТЗ зі статусом і відхиленнями.
- Після злиття в `main` — власник проганяє тест (розділ 10) і слухає чотири ролики. Тести це не покажуть.

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | `pnpm typecheck` + команди з 2.5 + `pnpm smoke` | Ні |
| Після злиття хвилі 1 | команди з розділу 6 | Ні |
| Блок змінив спільний файл | + тести модулів-споживачів: `music.ts` → `test/stage.test.ts`; `variants.ts` → `test/mixer.test.ts`, `test/stage.test.ts`; `plan.ts` → `test/music.test.ts`, `test/stage.test.ts`; `manifest.ts` → `test/stage.test.ts`; `pipe.ts`/`driver.ts` → `pipeline/test/machine.test.ts`, `integration/test/eval.test.ts`; `machine.ts` → на інтеграції ще `integration/test/pipeline.test.ts`, `eval-run.test.ts` | Ні |
| **Фінал — усе злито** | `pnpm typecheck && pnpm lint && pnpm test` | **Так, один раз** |

Правила для агента (дослівно в кожен брифінг):

- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на `main` до
  змін; якщо падало — не чіпай, лише зафіксуй у звіті.» Відомі червоні на Windows на `main` (cc7591c):
  `director/test/check-strip.test.ts` («кадри стрічки в усіх форматах…»), `integration/test/eval-run.test.ts`
  («--from render»).
- «Фінальний прогін — це ворота: поки він не зелений (або червоне підтверджено як наявне на `main`), ТЗ не
  вважається виконаним.»
- «Жодних платних прогонів (`LIVE=1`, `sfx-cache`, `eval` з ключами, `live:epidemic`) у блоках. Жодного
  реального виклику Epidemic з тестів: клієнт у тестах — лише через ін'єктований `fetch` або `mockEpidemic`.»
- «Хеші кешу ElevenLabs (`musicPlanHash`, `sfxHash`, `soundtrackHash`) не змінюються. Якщо тест із
  зафіксованим хешем почервонів — це баг блоку, а не привід оновити очікування.»

## 8. Review і Definition of Done

**На блок:** тести блоку зелені; `pnpm lint` чистий на змінених файлах; `pnpm typecheck` зелений; жодних
правок поза файлами з карти володіння; PR в інтеграційну гілку з маленьким diff і описом «що входить /
перевірки / що лишилось».

**На Крок 0:** усі схеми адитивні (тести парсингу старих JSON), заглушки компілюються, `prompts.test.ts` і
`pnpm smoke` зелені, `.env.example` оновлено.

**На ТЗ:** фінальний повний прогін зелений (або червоне збігається зі списком вище); README оновлено;
власник прогнав обидва прогони розділу 10, чотири mp4 на місці, лічильник Epidemic після тесту ≤ 45, у
розділ 11 записано: id треків і кількість семплів Epidemic на ролик, витрачені завантаження, попередження
темпу (якщо були) і суб'єктивну оцінку звуку по кожній комбінації.

## 9. Запуск у Claude Code

- Крок 0 — одна сесія, окремий PR у `main`. Поки не влито, блоки не стартують.
- Хвиля 1 — шість сесій Desktop (кожна отримує свій worktree від інтеграційної гілки): B1…B6. Стеля
  паралелі — 4 одночасно; порядок старту: B1 + B2 + B3 + B4, потім B5 + B6 (вони найменші).
  CLI-еквівалент: `claude -w epidemic-b1` … `claude -w epidemic-b6`.
- Брифінг кожної сесії: посилання на цей файл і на дизайн, ID блоку, карта володіння, команда тестів,
  правила з розділу 7, нагадування про `.env.local` і `pnpm install` у свіжому worktree.
- `main` тримати чистим; після merge — `git worktree remove`.

## 10. Як прогнати тест (власник, після злиття в `main`)

Передумови: у кореневому `.env` — `EPIDEMIC_API_KEY`, `ADC_EPIDEMIC_DIR=<абсолютний шлях>`; кеш SFX ElevenLabs
прогрітий (`pnpm sfx-cache --recheck` без `missing`).

1. **Прогін 1 (комбінація A)** — повний пайплайн, рецензію вимкнено (дизайн §5: інакше `fix` може змінити
   картинку між прогонами):
   ```bash
   ADC_MUSIC_PROVIDER=epidemic ADC_SFX_PROVIDER=elevenlabs ADC_FILM_REVIEW=off LIVE=1 pnpm eval --sites eval/sites.epidemic.json
   ```
2. **Прогін 2 (комбінація B)** — лише звукова гілка на картинці прогону 1 (`audio{music}` → зведення за
   `sfx-plan.json` прогону 1, звукорежисер не перезапускається — дизайн §6.2):
   ```bash
   ADC_MUSIC_PROVIDER=elevenlabs ADC_SFX_PROVIDER=epidemic ADC_FILM_REVIEW=off LIVE=1 pnpm eval --from audio --run <тека прогону 1>
   ```
3. Чотири mp4: `eval/runs/<прогін 1>/sites/<сайт>/` і `eval/runs/<прогін 1>.from-audio/sites/<сайт>/`.
   У `report.md` обох прогонів — провайдери, id треку, семпли й завантаження Epidemic.
4. Очікуваний бюджет: A — 2 сайти × (версія + завантаження, можливий один повтор) = 4–8; B — ≈15–20
   унікальних семплів (другий сайт бере спільні cue з кешу). Разом ≤ 30 із порогу 45.

Якщо прогін зупинився з `epidemic_quota` — тест далі не ганяти; дивитись `downloads.json`, вирішувати з
власником.

## 11. Рішення, які зафіксовано, і відкриті питання

Зафіксовано (понад дизайн §7):

- API-ключ напряму в `Authorization: Bearer`, без `/v0/token`; клієнт на `fetch`, без SDK.
- Трек підганяється через `POST /v0/tracks/versions` на `planTrackMs` (відео + 8 с), далі той самий
  `checkTrack`/`chooseWindowOffset`; збій версії → повний трек через `/download` і вікно з нього.
- Темп: три діапазони пошуку (t, t/2, 2t) з ±6, потім ±10, потім найближчий з попередженням.
- Один виклик LLM на вибір треку (`claude-sonnet-5-5`, `low`); другий кандидат при провалі `checkTrack` —
  наступний за списком, без нового виклику.
- Пошукова фраза SFX — окремий файл `prompts/epidemic/sfx-terms.md`, а не текст ElevenLabs; варіант `k` =
  `k`-й результат, кандидати довші за 2× cue — у кінець списку.
- Файли Epidemic (семпли, трек) копіюються у сховище проєкту, мікшер і хеш зведення не змінюються.
- Квота: лічиться `version` + `version_fetch` + `track` + `sfx`; поріг 45; дефолт теки
  `<корінь checkout>/.data/epidemic`, перевизначення `ADC_EPIDEMIC_DIR`.
- `--from audio` скидає `project.audioPlanHash`; правило перевикористання треку враховує провайдера.

Відкриті (вирішуються після прослуховування):

- Чи варто для SFX брати `quality: high` (посилання живе 1 год — для нас байдуже, але файл важчий) — зараз `normal`.
- Чи точно `versions` тримає темп і структуру на 33 с (бета) — перевіряється на практиці; якщо ні, фолбек
  на `highlights?duration=` + повний трек.
- Чи потрібен перемикач у веб-чаті (дизайн: не-ціль) і комерційний тариф — після рішення власника за слухом.

### Статус виконання

Хвиля 1 зроблена в одній гілці `claude/epidemic-sound-wave-1-8a3bcf` (вона ж інтеграційна): блоки йшли
паралельно в одному checkout на непересічних файлах за картою §4, кожен блок — окремий коміт.

| Блок | Коміт | Що зроблено |
|---|---|---|
| Крок 0 | PR #40 | перемикачі, схеми, `provider.ts`, заглушки, моки |
| B1 | `e8f23a6` | клієнт на `fetch`, класифікація помилок, квота `downloads.json` (поріг 45), `EpidemicGate` + `defaultEpidemicGate`, `live:epidemic` |
| B3 | `f424eb1` | SFX з каталогу, `sfx-terms.md` (30 cue), спільна ротація `variantIndices`/`chooseVariants` |
| B5 | `f5249f2` | провайдери в `pipe` на старті ревізії, у параметрах кожного `audio` |
| B2 | `acafb02` | музика з каталогу: темп t/½t/2t ±6 → ±10 → найближчий, вибір LLM, `tracks/versions` з фолбеком, `finalizeMusic`, `musicPlanHashFor` |
| B4 | `5819adf` | стадія `audio`: перемикання, правило перевикористання з провайдером, SFX лише потрібних варіантів, маніфест |
| B6 | `6893a12` | eval: перевірки до старту, `prepareRerun` з провайдерами і скиданням `audioPlanHash`, звіт, `sites.epidemic.json` |

Відхилення від тексту ТЗ (свідомі):

- **Порядок комітів** B1 → B3 → B5 → B2 → B4 → B6 (за готовністю); конфліктів не було — файли не перетинались.
- **B1:** таймаут запиту класифікується як `network` (черга повторює), `aborted` — лише сигнал викликача;
  `consume` серіалізується в процесі; зіпсований `downloads.json` — помилка, а не скидання на 0.
- **B2:** ін'єктований `sleep` — через розширений тип `EpidemicMusicDeps` (у `EnsureMusicFn` поля немає;
  `provider.ts` не змінювався); схема вибору називається `MusicPickDraft`; збій виклику LLM → перший
  кандидат; ключ постійного кешу `music/<trackId>-<planTrackMs>.mp3` і для версії, і для повного треку;
  рядок витрат — на кожен отриманий аудіофайл; усі пошуки порожні → `EpidemicError("not_found")`.
- **B3:** «наступний невикористаний кандидат» для повтору QC пропускає основних кандидатів інших
  варіантів того ж cue; QC перераховується щоразу (локально, дешево).
- **B4:** `canReuseMusic` живе в `stage.ts` і отримав 4-й аргумент `provider`; клієнт Epidemic
  резолвиться на старті стадії, якщо фаза його потребує (повний кеш-прогін з `epidemic` теж вимагає ключ);
  інші помилки SFX Epidemic (не квота/ключ) — попередження, події німіють, як у ElevenLabs.
- **B6:** рядок «Завантажень Epidemic за прогін» друкується завжди (у прогоні лише з ElevenLabs —
  `0 (лічильник: — з 50)`); у `CaseReport` поле названо `providers` (`audio` уже зайняте метриками).

### Результати тесту (2026-10-20)

Усі ролики — на одній картинці прогону `2026-10-20-1157` (рецензія off), сайти webreportio-parity і profitstore.

| Комбінація | Прогін | Музика | SFX | Завантажень Epidemic |
|---|---|---|---|---|
| A | `2026-10-20-1157` | Epidemic: «Hourglass» (Flux Vortex, `dfbb5594…`) / «Another Night, New Town» (`f7369650…`), обидва 120 BPM = розкадровка, `checkTrack` ok | ElevenLabs | 8 (по 4 на сайт: перший кандидат не пройшов `checkTrack`, кожен — `version` + `track`) |
| усе з Epidemic | `2026-10-20-1348.from-audio` | ті самі треки з кешу | Epidemic: 27 / 23 семпли (без звуку: `shimmer`; `glitch`, `tick`, `shimmer`) | 0 (лише кеш) |
| B | `2026-10-20-1354.from-audio` | ElevenLabs (`music_v2_5`, 120 BPM, ok) | Epidemic: 27 / 23 семпли, як вище | 0 (лише кеш) |

Попереджень темпу не було. Лічильник після тесту — 45 з 50.

Що пішло не за планом:

- **`tracks/versions` жодного разу не дійшов до `COMPLETED`**: збій на першому ж опитуванні, музика вирізалась з
  повного треку, тож кожен кандидат коштував 2 завантаження. Причина — ймовірно, проміжний статус поза
  довідкою; виправлено в PR #47 (очікування проміжних статусів, `versionStatus` у `music.json` і звіті).
- **SFX з'їли квоту**: перший прогін «усе з Epidemic» витратив 37 завантажень на одному сайті й зупинився на
  порозі 45. Обрізання до тривалості cue йшло від початку файлу й лишало тишу каталожного семпла, QC бачив
  пізній onset і тихий пик і качав другого кандидата (25 з 37). Виправлено в PR #46: обрізання тиші до QC,
  повтор лише з вагомої причини, режим `ADC_EPIDEMIC_CACHE_ONLY=1` — ним і зроблено прогони «усе з Epidemic»
  і B, без нових завантажень.

**Оцінка власника на слух:** найкраща комбінація — **A: музика Epidemic Sound, SFX ElevenLabs**.
