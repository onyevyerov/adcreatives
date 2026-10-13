# ТЗ: якість звуку — формат, моно-сумісність, LUFS, такт, тональність, хук і фінал

Дата: 2026-10-13. Формат — parallel-ready: Крок 0 заморожує інтерфейси й вимірювальні утиліти, далі блоки без
спільних файлів. Орієнтир — документ «Проектирование production-ready пайплайнов для генерации аудио под
AI-видео» (Gemini, 2026-10) і замір реального проєкту `QrsPgSOfm8mGSsIXhlYv6` (трек `music_v2_5`, 28 с, 120 BPM).

## 1. Мета і контекст

Пайплайн звуку (`packages/audio`) архітектурно вже відповідає документу: композитна схема (музика ElevenLabs +
бібліотека SFX + зведення кодом), HPF-дакінг на долю, спільний реверб, audio-first синхронізація (BPM із сітки,
сцени на тактах, події на пів-долях). Замір показав, де саме втрачається якість; це ТЗ закриває ці втрати без
зміни постачальника (рішення власника 2026-10-12: музика й SFX — ElevenLabs) і без зміни схеми розкадровки.

Замір (трек, `music.wav`, `soundtrack.wav`, `vertical.mp4`, 30 SFX з кешу):

| Місце | Виміряно | Втрата |
|---|---|---|
| Формат треку `mp3_44100_128` | 12–16 кГц −35 дБ, вище 16 кГц −67 дБ відносно загальної енергії | верх зрізано на ~16 кГц |
| Стерео треку | кореляція L/R 0.99 по всьому спектру | трек фактично моно |
| SFX із протифазою | `impact.1` corr −0.89, `impact.2` −0.44, `click.1` −0.65 | у моно (телефон) удар зникає |
| Тихі SFX | `ding.2` пік −34 dBFS, `shimmer.2` −28, `slam.3` −26, `click.1` −22 | нормалізація піку до 0 дБ піднімає шум mp3 на 22–34 дБ |
| Тональні cue | впевнений pitch лише у `pop.3`, `ding.1-3`, `shimmer.2-3` | 2 з 3 варіантів pop не строяться; ротація чергує строєні й ні |
| Ротація варіантів | лічильник глобальний на cue | у списку з 6 pop тембр міняється щоряд |
| Мастер | RMS −14 dBFS до автоматизації, кліпер tanh від −6 dBFS | −14.8 LUFS / −1.3 dBTP вийшло випадково; LUFS і true peak не міряються |
| Хук | s1 `filtered`: 4 с на −19.5…−17.6 dBFS проти −13.8 далі, LPF 800 Гц | перші секунди приглушені й на 5–6 дБ тихіші |
| Фінал | fade-out 1 с завжди | ролик згасає, а не закінчується на долі |
| Вирівнювання | `alignToBeatGrid` — лише фаза долі | сцени «на тактах» можуть лягти на 2-гу чи 3-тю долю |
| Тональність | ключ плану не звіряється з треком | події можуть строїтись у чужу тональність |
| Реверб | IR = білий шум × експонента, посил у моно | металевий хвіст, події втрачають позицію |
| Riser | `at ≤ durationFrames − 1` | riser не може закінчитись на 1-му кадрі наступної сцени (у проєкті — за 233 мс до slam) |
| Рендер | мікс 44.1 кГц, Remotion кодує на 48 кГц | зайвий ресемплінг (смуга 16–20 кГц у mp4 піднялась з −63 до −48 дБ) |

**Незмінне:** `SoundtrackInput` і `Soundtrack` (крім адитивних полів), детермінований побайтово мікс, `audio.json`
старих ревізій парситься, хост грає `soundtrack.wav` як є, guard коду сцен, чекпоінти власника.

**Вартість:** блоки не додають платних викликів, крім A2 (до 2 повторних генерацій SFX на варіант, лише при
прогріві кешу; ≈ $0.01 за варіант) і A1 (той самий тариф за хвилину; форматів вищої якості може не бути на
поточному тарифі — тоді фолбек на `mp3_44100_128` без збою).

## 2. Крок 0 — заморожені інтерфейси й вимірювання (робиться першим, окремим PR)

Усі зміни схем — адитивні з дефолтами. Поки Крок 0 не влитий у `main`, паралель не стартує.

### 2.1 Схеми — `packages/shared/src/schemas/audioPlan.ts`, `packages/shared/src/types/video.ts`

```ts
// MusicTrackCheck (адитивно, усі з .default(null))
keyDetected: z.object({ root: z.number().int().min(0).max(11), minor: z.boolean(), confidence: z.number() }).nullable(),
/** Зсув першої сильної долі (downbeat) відносно сітки долей, мс; null — не визначено. */
barOffsetMs: z.number().nullable(),
barConfidence: z.number().nullable(),
/** Кореляція L/R усього треку (−1..1) і нижче 150 Гц. */
stereoCorrelation: z.number().nullable(),
lowCorrelation: z.number().nullable(),
integratedLufs: z.number().nullable(),
truePeakDbtp: z.number().nullable(),

// AudioManifest.mix (адитивно)
integratedLufs: z.number().nullable().default(null),
truePeakDbtp: z.number().nullable().default(null),
masterGainDb: z.number().nullable().default(null),
```

### 2.2 Вимірювальні утиліти (повна реалізація в Кроці 0, бо їх читають 6 блоків)

- `packages/audio/src/loudness.ts`: `measureLoudness(pcm: StereoPcm): { integratedLufs; shortTermMaxLufs;
  momentaryMaxLufs }` за ITU-R BS.1770-4 (K-фільтр, блоки 400 мс / 75 %, абсолютний гейт −70, відносний −10 LU);
  `truePeakDb(pcm): number` з 4× оверсемплінгом (windowed sinc, 48 відводів). Без залежностей.
- `packages/audio/src/stereo.ts`: `correlation(pcm, belowHz?: number): number` (−1..1; з `belowHz` — після LPF
  12 дБ/окт на обох каналах); `monoFold(pcm, opts: { belowHz: number | null }): StereoPcm` (null — повністю в моно
  `(L+R)/2` в обидва канали; число — лише смуга нижче `belowHz` у моно, решта без змін, лінійно-фазово через
  суму/різницю з тим самим LPF). Чисті функції, нова копія.
- CLI `scripts/audio-measure.ts` (+ скрипт `audio-measure` у кореневому `package.json`): аргумент — шлях до
  wav/mp3/mp4 або `--project <id> [--rev n]`, друкує LUFS, dBTP, RMS, crest, кореляції, енергію смуг
  (20–60, 60–150, 150–500, 500–2k, 2k–6k, 6k–12k, 12k–16k, 16k–20k), RMS по секундах; `--sfx-cache` — таблиця по
  всіх семплах кешу (тривалість, onset, якір, пік, pitch, кореляція). Декодує через `decodeAudio`. Це інструмент
  приймання для всіх блоків.

### 2.3 Точки підключення в зведенні — `packages/audio/src/mixer.ts` (власник після Кроку 0 — A4)

- `MIX_VERSION = 4` один раз тут; блоки хвилі 1 версію **не** підвищують (кеш зведень і так інвалідується).
- `packages/audio/src/width.ts`: `widenMusic(pcm: StereoPcm): StereoPcm` — у Кроці 0 повертає копію без змін;
  `mixer.ts` викликає її після нормалізації музики, до автоматизації. Реалізує A11.
- `packages/audio/src/master.ts`: `masterize(sum: StereoPcm, opts: { sampleRate: number }): { pcm: StereoPcm;
  gainDb: number; integratedLufs: number; truePeakDbtp: number }` — у Кроці 0 переносить поточний софт-кліпер
  (`softClip`, knee −6, стеля −1, антиклік 10 мс) без зміни поведінки, `gainDb = 0`, LUFS/dBTP міряє через
  `loudness.ts`. `Soundtrack` отримує адитивно `master: { gainDb; integratedLufs; truePeakDbtp }`. Реалізує A4.
- `packages/audio/src/variants.ts`: `chooseVariants(placements: readonly EventPlacement[], library:
  ReadonlyMap<SoundCue, PreparedEntry[]>): PreparedEntry[]` — перенесена дослівно поточна ротація (лічильник на
  cue). `PreparedEntry` і `prepareLibrary` переїжджають у `variants.ts` і експортуються. Реалізує A5.
- `packages/audio/src/automation.ts`: `AutomationOptions = { fps: number; bpm: number }` — fade-out більше не
  передається з `mixer.ts`; константа `MUSIC_TAIL_FADE_SEC = 1` переїжджає в `automation.ts` (експорт), поведінка
  та сама. Реалізує зміну закінчення A7.
- Тести fade-out з `test/mixer.test.ts` переносяться у новий `test/automation.test.ts` (без зміни тверджень).

### 2.4 Точки підключення в перевірці треку — `packages/audio/src/trackCheck.ts`, `stage.ts`

- `packages/audio/src/keyDetect.ts`: `detectKey(pcm: StereoPcm): KeyEstimate | null` (`{ root, minor,
  confidence }`), у Кроці 0 — `null`; `resolveEventKey(check: MusicTrackCheck | null, planKey: string | null):
  string | null` — у Кроці 0 повертає `planKey`. Реалізує A5.
- `packages/audio/src/bars.ts`: `estimateBarPhase(pcm: StereoPcm, bpm: number, beatOffsetSec: number):
  { barOffsetSec: number; confidence: number } | null`, у Кроці 0 — `null`. Реалізує A6.
- `checkTrack` заповнює нові поля: `keyDetected` і `barOffsetMs`/`barConfidence` через заглушки, `stereoCorrelation`,
  `lowCorrelation`, `integratedLufs`, `truePeakDbtp` — по-справжньому (утиліти Кроку 0).
- `stage.ts`: у `renderSoundtrack` передається `key: resolveEventKey(music.meta.check, plan.key)`; `manifest.mix`
  отримує `integratedLufs`, `truePeakDbtp`, `masterGainDb` із `soundtrack.master`; `buildAudioManifest`
  (`manifest.ts`) приймає ці поля. Лог «зведення готове» друкує LUFS і dBTP.

### 2.5 Контроль якості SFX — `packages/audio/src/sfx.ts`, `sfxQc.ts`

- `packages/audio/src/sfxQc.ts`: схема `SfxQc = z.object({ ok, peakDb, onsetMs, correlation, pitchHz:
  z.number().nullable(), reasons: z.array(z.string()), attempts: z.number().int() })`; тип хука
  `SfxQcHook = (audio: Buffer, cue: string, def: CueDefinition, signal?: AbortSignal) => Promise<SfxQc>`;
  `defaultSfxQc: SfxQcHook` у Кроці 0 повертає `{ ok: true, … }` без декодування. Реалізує A2.
- `sfx.ts`: `SfxDeps.qc?: SfxQcHook`; `ensureCached` викликає хук після генерації, при `ok=false` повторює
  генерацію до `SFX_QC_MAX_RETRIES = 2` разів і кладе в кеш найкращу спробу (менше `reasons`), `SfxCacheMeta`
  отримує `qc: SfxQc.nullable().default(null)` і `outputFormat: z.string().default("mp3_44100_128")`. Хук
  передається з `sfxCache.ts` і `stage.ts` (`deps.qc ?? defaultSfxQc`).

### 2.6 Тести Кроку 0

- `packages/audio/test/loudness.test.ts`: синус 997 Гц −20 dBFS → −23.0 ±0.3 LUFS (калібрування BS.1770);
  тиша не входить у гейт; true peak міжсемплового піку > семплового.
- `packages/audio/test/stereo.test.ts`: кореляція ідентичних каналів 1, протифазних −1; `monoFold` з `belowHz`
  лишає верх без змін і робить низ моно.
- `packages/shared/test/schemas.test.ts`: старі `music.json` і `audio.json` парсяться з новими полями `null`.
- `packages/audio/test/mixer.test.ts` і новий `automation.test.ts` зелені без зміни тверджень (поведінка та сама).
- Команда: `pnpm --filter @adc/audio test -- test/loudness.test.ts test/stereo.test.ts test/mixer.test.ts test/automation.test.ts test/trackCheck.test.ts test/stage.test.ts test/sfx.test.ts && pnpm --filter @adc/shared test -- test/schemas.test.ts`
- Smoke: `pnpm audio-measure -- --project QrsPgSOfm8mGSsIXhlYv6` друкує таблицю.

## 3. Блоки робіт (хвиля 1, усі паралельно після Кроку 0)

#### A1: Формат вихідних даних ElevenLabs
- Володіє: `packages/audio/src/constants.ts`, `packages/audio/src/client.ts`, `packages/audio/src/decode.ts`,
  `packages/audio/src/errors.ts`, `packages/audio/src/music.ts`, `packages/audio/src/sfx.ts` (після Кроку 0);
  тести `test/decode.test.ts`, `test/music.test.ts`, `test/sfx.test.ts`.
- Залежить від: Крок 0 (`SfxCacheMeta.outputFormat`).
- Критерії приймання:
  - `MUSIC_OUTPUT_FORMAT` і новий `SFX_OUTPUT_FORMAT` читаються з env `ELEVENLABS_MUSIC_FORMAT` /
    `ELEVENLABS_SFX_FORMAT` (дефолт `mp3_44100_192`), допустимі значення — `mp3_44100_128`, `mp3_44100_192`,
    `pcm_44100`; невалідне значення — помилка старту;
  - `textToSoundEffects.convert` передає `outputFormat`; `sfxHash` включає формат (зміна формату = новий файл у
    кеші); розширення файлу в кеші й у `public/sfx/` відповідає вмісту (`.mp3` або `.wav`, PCM загортається в WAV
    через `encodeWav` одразу після отримання);
  - `errors.ts` розпізнає відмову «формат недоступний на тарифі» (`kind: "format_not_allowed"`); `music.ts` і
    `sfx.ts` (через `SfxDeps.formatFallback`, читається з `constants.ts`) один раз повторюють запит із
    `mp3_44100_128` і пишуть попередження в лог;
  - `decode.ts` декодує і mp3, і PCM/WAV тим самим `decodeAudio` (WAV — через `decodeWav` без ffmpeg);
  - `planHash` музики змінюється від формату (уже так через `MUSIC_OUTPUT_FORMAT` у хеші).
- Тести: `pnpm --filter @adc/audio test -- test/decode.test.ts test/music.test.ts test/sfx.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A2: Контроль якості SFX при прогріві кешу
- Володіє: `packages/audio/src/sfxQc.ts` (реалізація), `packages/audio/src/sfxCache.ts`,
  `prompts/elevenlabs/sfx-cues.md`; тести нові `test/sfxQc.test.ts`, `test/sfxCache.test.ts`.
- Залежить від: Крок 0 (хук `SfxQcHook`, `stereo.ts`, `loudness.ts`; `analyzeSample` з `samples.ts` — read-only).
- Критерії приймання:
  - `defaultSfxQc` декодує семпл і перевіряє: пік ≥ −12 dBFS; onset (поріг −24 дБ від піку) ≤ 50 мс для всіх cue,
    крім `riser` (≤ 400 мс); кореляція L/R ≥ 0.3 для `impact`, `slam`, `pop`, `ding`, `tick`, `click`,
    `shimmer` і ≥ −0.2 для `whoosh`, `swoosh`, `riser`; для `pop`, `ding`, `shimmer` — впевнений pitch
    (`PITCH_CONFIDENCE`); `reasons` перелічує порушення;
  - повтор генерації (до 2) при `ok=false`; у кеш — найкраща спроба, `qc` і `attempts` у `<hash>.json`;
    `warmSfxCache` друкує таблицю з `qc.ok` і причинами;
  - `pnpm sfx-cache --recheck` переганяє QC по наявному кешу без платних викликів і друкує, які файли не проходять;
    `--regenerate-failed` видаляє їх і генерує заново (платно, лише з `LIVE=1`);
  - у `sfx-cues.md` кожен текст доповнюється «loud and clean, normalized, centered in the stereo image»;
    тексти `pop.1`, `pop.2`, `shimmer.1` переписуються так, щоб звук мав одну чітку ноту (наприклад «one
    clear sustained note around C5»); зміна тексту = новий хеш, старі файли лишаються, але не використовуються.
- Тести: `pnpm --filter @adc/audio test -- test/sfxQc.test.ts test/sfxCache.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A3: Моно-сумісність звуків подій
- Володіє: `packages/audio/src/samples.ts`; тест `test/samples.test.ts`.
- Залежить від: Крок 0 (`stereo.ts`).
- Критерії приймання:
  - `renderSample` після ресемплінгу й до нормалізації застосовує політику: `impact`, `slam` — `monoFold(…, { belowHz:
    null })` (повністю моно); решта — `monoFold(…, { belowHz: 150 })`; додатково, якщо `correlation(pcm) < 0.3`
    для будь-якого cue — повністю моно;
  - `SampleAnalysis` отримує адитивно `correlation: number` і `monoFolded: boolean`;
  - тест: семпл із протифазними каналами після `renderSample` має моно-суму не тихішу за канал більш ніж на 3 дБ;
    whoosh з декорельованим шумом (corr ≈ 0) лишає верх стерео, низ моно.
- Тести: `pnpm --filter @adc/audio test -- test/samples.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A4: Мастер — LUFS і true peak замість RMS і tanh
- Володіє: `packages/audio/src/master.ts`, `packages/audio/src/mixer.ts`; тести новий `test/master.test.ts`,
  `test/mixer.test.ts`.
- Залежить від: Крок 0 (`loudness.ts`, `masterize` у `master.ts`).
- Критерії приймання:
  - `MASTER_TARGET_LUFS = −14`, `MASTER_TRUE_PEAK_DBTP = −1`; `masterize`: виміряти інтегральний LUFS суми
    (музика з автоматизацією і дакінгом + події + реверб), підсилити на різницю до цілі в межах `±12 дБ`, далі
    true-peak лімітер (4× оверсемплінг, lookahead 1.5 мс, атака 0.5 мс, реліз 50 мс, стеля −1 dBTP) замість
    `softClip`; антиклік 10 мс у кінці лишається;
  - попередня нормалізація музики до `MASTER_RMS_DBFS` лишається як груба опора для рівнів подій (`CUE_LEVEL_DB`
    рахуються відносно неї, як зараз), але підсумкова гучність визначається `masterize`;
  - результат детермінований побайтово; `Soundtrack.master` заповнений; на фікстурі `fixtureStoryboard` з
    `steadyBed`: `integratedLufs` −14 ±0.5, `truePeakDbtp` ≤ −1.0; на треку з піками до −0.5 dBFS лімітер не
    дає семплів вище −1 dBFS;
  - тести `mixer.test.ts` про «RMS ≈ −14 dBFS» замінюються на LUFS-твердження; тест рівнів подій лишається.
- Тести: `pnpm --filter @adc/audio test -- test/master.test.ts test/mixer.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A5: Тональні події — ключ треку, вибір варіантів
- Володіє: `packages/audio/src/keyDetect.ts`, `packages/audio/src/variants.ts`; тести нові `test/keyDetect.test.ts`,
  `test/variants.test.ts`.
- Залежить від: Крок 0 (`detectKey`/`resolveEventKey` заглушки, `chooseVariants`, `PreparedEntry`).
- Критерії приймання:
  - `detectKey`: хрома через FFT (4096, крок 2048, 60–5000 Гц, сума по октавах) → кореляція з профілями
    Krumhansl–Schmuckler для 24 тональностей; `confidence` = різниця між найкращим і другим збігом,
    нормована; тест: синтезований тризвук A minor (арпеджіо 8 с) → `{ root: 9, minor: true }`, `confidence ≥ 0.2`;
  - `resolveEventKey`: якщо `check.keyDetected.confidence ≥ 0.2` і тональність відрізняється від плану — ключ
    треку (лог «тональність треку відрізняється від плану»), інакше ключ плану;
  - `chooseVariants`: для `pop`, `ding`, `shimmer` — лише варіанти з `analysis.pitchHz !== null`; якщо таких
    немає — всі; ротація для `pop`/`ding` — один варіант на сцену (наступна сцена бере наступний варіант), для
    решти cue — як зараз по колу;
  - `soundtrackHash` без змін (порядок варіантів у бібліотеці вже в хеші).
- Тести: `pnpm --filter @adc/audio test -- test/keyDetect.test.ts test/variants.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A6: Такт замість долі — downbeat у вирівнюванні й вікні
- Володіє: `packages/audio/src/bars.ts`, `packages/audio/src/beat.ts`, `packages/audio/src/trackCheck.ts`; тести
  новий `test/bars.test.ts`, `test/beat.test.ts`, `test/trackCheck.test.ts`, хелпер `test/trackSignals.ts`.
- Залежить від: Крок 0 (`estimateBarPhase` заглушка, поля `barOffsetMs`/`barConfidence`).
- Критерії приймання:
  - `estimateBarPhase`: для чотирьох кандидатів фази такту (0..3 долі від `beatOffsetSec`) рахує оцінку: сила
    низькочастотних онсетів на долях 1 і 3 проти 2 і 4 плюс енергія середньої смуги 1–4 кГц (claps) на долях
    2 і 4; `confidence` — нормований відрив найкращого кандидата; поріг `MIN_BAR_CONFIDENCE = 0.2`;
  - `alignToBeatGrid` (сигнатура та сама): при впевненій фазі такту зсуває трек так, щоб downbeat ліг на кадр 0
    (обрізання ≤ 1 такт, або тиша ≤ 150 мс як зараз); `BeatAlignment` адитивно отримує `barOffsetSec`,
    `barConfidence`;
  - `chooseWindowOffset` рахує зсуви від `barOffsetMs` (кратно такту від першого downbeat), `checkTrack` пише
    `barOffsetMs`/`barConfidence`;
  - `trackSignals.ts`: метроном із бочкою на 1 і 3, клапом на 2 і 4; тест: трек зі зсувом на 2 долі стає на
    downbeat; трек без акцентів — лише фаза долі (як зараз).
- Тести: `pnpm --filter @adc/audio test -- test/bars.test.ts test/beat.test.ts test/trackCheck.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A7: Хук і фінал — відкриття без приглушення, закінчення на долі
- Володіє: `packages/audio/src/automation.ts`, `prompts/storyboard.md`; тест `test/automation.test.ts`.
- Залежить від: Крок 0 (`AutomationOptions` без fade, `automation.test.ts`).
- Критерії приймання:
  - закінчення: замість fade-out 1 с — повний рівень до кінця і raised-cosine `ENDING_FADE_SEC = 0.25` в останніх
    250 мс (хвіст реверба подій і так у міксі); `MUSIC_TAIL_FADE_SEC` видаляється;
  - `MIX_SETTINGS.filtered` → `{ cutoffHz: 1600, gainDb: −3 }` (м'якше), `breakdown` без змін;
  - `prompts/storyboard.md`, розділ «Music»: перша частина `structure`, що покриває сцену `hook`, має `mix:
    "full"`; `filtered` — для `problem` або `build`, не для хука; явне речення «The film opens at full level:
    the hook is not an intro»; розділ «Moments»: «A `riser` may end on the first frame of the next scene:
    give it `at` equal to `durationFrames`» (код з A8 це дозволяє; до злиття A8 нормалізація підрізає до
    `durationFrames − 1`, що безпечно);
  - тест: RMS останніх 100 мс ≥ −3 дБ від RMS попередньої секунди мінус fade; `filtered` тихіший за `full` на
    2.5–4 дБ.
- Тести: `pnpm --filter @adc/audio test -- test/automation.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A8: Riser до наступної сцени
- Володіє: `packages/director/src/normalize.ts` (секція подій: `placeEvents`, `limitHits`); тест
  `packages/director/test/normalize.test.ts`.
- Залежить від: нічого нового (схема `SceneEvent.at` без верхньої межі).
- Критерії приймання:
  - для події з `sound.cue === "riser"` верхня межа `at` — `durationFrames` (не `− 1`); для решти — як зараз;
  - після прив'язки до сітки: якщо наступна озвучена подія (у цій або наступній сцені) не далі ніж пів долі від
    кінця riser — `at` riser підтягується до її кадру (у межах сцени, тобто до `durationFrames`), запис у `changes`;
  - `computeEventPlacements` з `at = durationFrames` дає `frame = from + durationFrames` = перший кадр наступної
    сцени (перевірити тестом у `normalize.test.ts`, timeline не змінюється);
  - попередження про riser довший за 2 такти лишається.
- Тести: `pnpm --filter @adc/director test -- test/normalize.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A9: Реверб — демпфування верху, стерео-посил
- Володіє: `packages/audio/src/reverb.ts`; тест `test/reverb.test.ts`.
- Залежить від: нічого нового (сигнатура `applyReverb(send: StereoPcm, ir?)` та сама).
- Критерії приймання:
  - IR двосмуговий: нижче 3 кГц спад до −60 дБ за 1.2 с, вище — за 0.5 с (два шумові IR через LPF/HPF 3 кГц,
    сума); на хвості LPF 6 кГц; предзатримка 10 мс лишається; одинична енергія;
  - посил: HPF 200 Гц на вході; стерео: `L → IR_L`, `R → IR_R` з перехресним посилом 0.3 (замість моно-суми);
  - детермінованість побайтова; `REVERB_SEND` без змін; тест: імпульс у лівому каналі дає хвіст гучніший
    зліва ≥ 3 дБ; енергія хвоста вище 6 кГц ≤ −20 дБ від загальної.
- Тести: `pnpm --filter @adc/audio test -- test/reverb.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A10: Рендер без ресемплінгу
- Володіє: `packages/render/src/engine.ts`; тест `packages/render/test/render.test.ts`.
- Залежить від: нічого.
- Критерії приймання: `renderMedia` отримує `sampleRate: 44100` (частота зведення, `SAMPLE_RATE` з `@adc/audio`
  не імпортується — константа дублюється в `engine.ts` з коментарем) і явний `audioBitrate: "320k"`; тест
  рендеру 2 с перевіряє, що аудіопотік mp4 має 44100 Гц (ffprobe-подібна перевірка через `ffmpeg -i` зі збірки
  Remotion або парсинг `mp4a` в контейнері).
- Тести: `pnpm --filter @adc/render test -- test/render.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A11: Ширина стерео музики
- Володіє: `packages/audio/src/width.ts`; тест новий `test/width.test.ts`.
- Залежить від: Крок 0 (`widenMusic` заглушка, `stereo.ts`).
- Критерії приймання:
  - M/S: `S = (L − R)/2` через HPF 300 Гц, підсилення side на `WIDTH_SIDE_DB = +4`, низ (< 300 Гц) лишається
    моно; якщо `correlation(pcm) < 0.6` — без змін (трек уже широкий); після обробки `correlation ≥ 0.6`
    (інакше side зменшується до виконання умови);
  - детермінованість; тест: моно-трек лишається моно (ширини нема звідки взяти), трек із side-компонентом
    ширшає, низ лишається моно (`correlation(pcm, 150) ≥ 0.98`).
- Тести: `pnpm --filter @adc/audio test -- test/width.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

#### A12: Зворотний зв'язок — метрики в eval і для автора
- Володіє: `scripts/eval.ts`, `packages/author/src/tools/meta.ts`, `docs/analysis/README.md`; тести
  `tests/integration/test/eval.test.ts`, `packages/author/test/stage.test.ts` (лише кейс `audio_events`).
- Залежить від: Крок 0 (поля `MusicTrackCheck`, `AudioManifest.mix`).
- Критерії приймання:
  - `report.json` eval отримує `audio: { integratedLufs, truePeakDbtp, masterGainDb, keyPlanned, keyDetected,
    barConfidence, stereoCorrelation, attempts, offsetMs }` з `audio.json` і `music.json`;
  - `audio_events` (read-only) додає заголовок із треком: BPM, тональність плану і треку, LUFS, впевненість
    долі/такту, ширина стерео — щоб агент-автор бачив, чим грає;
  - `docs/analysis/README.md`: процедура заміру через `pnpm audio-measure` і цільові значення (−14 ±1 LUFS,
    ≤ −1 dBTP, кореляція низу ≥ 0.9, SFX QC `ok`).
- Тести: `pnpm --filter @adc/integration test -- test/eval.test.ts && pnpm --filter @adc/author test -- test/stage.test.ts`
- Паралельність: одночасно з усіма блоками хвилі 1.

## 4. Карта володіння файлами

- Крок 0 → `packages/shared/src/schemas/audioPlan.ts`, `packages/shared/src/types/video.ts`,
  `packages/audio/src/loudness.ts`, `stereo.ts`, `width.ts` (заглушка), `master.ts` (перенос), `variants.ts`
  (перенос), `keyDetect.ts` (заглушка), `bars.ts` (заглушка), `sfxQc.ts` (схема + хук-заглушка), `mixer.ts`
  (підключення), `automation.ts` (опції), `trackCheck.ts` (поля), `stage.ts`, `manifest.ts`, `sfx.ts` (хук, мета),
  `scripts/audio-measure.ts`, кореневий `package.json`, `README.md` (рядок команди `audio-measure` і посилання на
  це ТЗ); тести `loudness.test.ts`, `stereo.test.ts`,
  `automation.test.ts` (перенос), `packages/shared/test/schemas.test.ts`.
- A1 → `packages/audio/src/constants.ts`, `client.ts`, `decode.ts`, `errors.ts`, `music.ts`, `sfx.ts`;
  `test/decode.test.ts`, `test/music.test.ts`, `test/sfx.test.ts`.
- A2 → `packages/audio/src/sfxQc.ts`, `sfxCache.ts`, `prompts/elevenlabs/sfx-cues.md`; `test/sfxQc.test.ts`,
  `test/sfxCache.test.ts`.
- A3 → `packages/audio/src/samples.ts`; `test/samples.test.ts`.
- A4 → `packages/audio/src/master.ts`, `mixer.ts`; `test/master.test.ts`, `test/mixer.test.ts`.
- A5 → `packages/audio/src/keyDetect.ts`, `variants.ts`; `test/keyDetect.test.ts`, `test/variants.test.ts`.
- A6 → `packages/audio/src/bars.ts`, `beat.ts`, `trackCheck.ts`; `test/bars.test.ts`, `test/beat.test.ts`,
  `test/trackCheck.test.ts`, `test/trackSignals.ts`.
- A7 → `packages/audio/src/automation.ts`, `prompts/storyboard.md`; `test/automation.test.ts`.
- A8 → `packages/director/src/normalize.ts`; `packages/director/test/normalize.test.ts`.
- A9 → `packages/audio/src/reverb.ts`; `test/reverb.test.ts`.
- A10 → `packages/render/src/engine.ts`; `packages/render/test/render.test.ts`.
- A11 → `packages/audio/src/width.ts`; `test/width.test.ts`.
- A12 → `scripts/eval.ts`, `packages/author/src/tools/meta.ts`, `docs/analysis/README.md`;
  `tests/integration/test/eval.test.ts`, `packages/author/test/stage.test.ts`.
- Спільні (один власник): `packages/audio/src/index.ts` (експорти нових модулів додає Крок 0, далі не чіпати:
  модулі експортуються через `export *`, нові символи з'являються самі); `packages/audio/src/constants.ts` → A1
  (інші блоки тримають свої константи у власних модулях, як `reverb.ts` і `automation.ts` уже роблять);
  `packages/audio/src/stage.ts` → Крок 0 (у хвилі 1 не чіпати); `test/mixer.test.ts` → A4; `test/sfx.test.ts` →
  A1; `test/stage.test.ts` → Крок 0; `test/helpers.ts`, `test/fakeSfx.ts`, `test/signals.ts` → не чіпати (нові
  сигнали — у власних тест-файлах блоку); `pnpm-lock.yaml` → не змінюється (залежностей не додаємо).

## 5. Спільні ресурси й ізоляція

- Worktree ізолює файли, але не `.data`, Redis і ключі. Платні виклики — лише в A2 (`LIVE=1 pnpm sfx-cache
  --regenerate-failed`) і A1 (ручна проба форматів `LIVE=1 pnpm --filter @adc/audio live`): запускає лише
  власник, один раз, після злиття хвилі; у блоках — лише моки (`ElevenLabsLike` із `test/helpers.ts`).
- `DATA_DIR` у кожному worktree свій (`.data` від кореня worktree); кеш SFX `DATA_DIR/cache/sfx` не ділиться.
  Для заміру на реальному проєкті `scripts/audio-measure.ts` приймає явний шлях до файлу — брати з основного
  checkout read-only.
- Для паралельних worktree — свій `REDIS_URL` (`/1`, `/2`, …) і `PORT` у `.env.local`, як у README; блокам
  цього ТЗ воркер не потрібен.
- Кеш зведень `audio/<planHash>/mix-<hash>.wav` і `music.wav` інвалідуються через `MIX_VERSION = 4` (Крок 0)
  і через новий `planHash` (A1); старі ревізії лишаються робочими.

## 6. План інтеграції

- Порядок злиття: Крок 0 → хвиля 1 у порядку готовності, рекомендовано A10, A8, A9, A11, A3, A1, A2, A5, A6,
  A7, A4, A12 (A4 останнім серед аудіо-блоків, бо володіє `mixer.ts` і підбирає всі хуки; A12 після всіх, бо
  читає їхні поля).
- Інтеграційна гілка: `claude/audio-quality` (від `main` після Кроку 0); кожен блок — гілка
  `claude/audio-quality-a<n>`, PR в інтеграційну; після кожного merge решта гілок оновлюється від інтеграційної.
- Після злиття хвилі 1:
  `pnpm --filter @adc/audio test && pnpm --filter @adc/director test -- test/normalize.test.ts && pnpm --filter @adc/render test -- test/render.test.ts && pnpm --filter @adc/integration test -- test/eval.test.ts && pnpm --filter @adc/author test -- test/stage.test.ts && pnpm smoke`
  плюс замір: `pnpm audio-measure -- <шлях до soundtrack.wav нового прогону>` і таблиця SFX після
  `LIVE=1 pnpm sfx-cache --regenerate-failed` (власник).
- Живий прогін (власник, один раз): один проєкт через чат, порівняти `audio-measure` до/після по таблиці з §1.

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | команда з §2.6 + `pnpm smoke` | Ні |
| Після злиття хвилі 1 | команда з §6 + smoke | Ні |
| Блок змінив спільний файл | A4 (`mixer.ts`): + `test/stage.test.ts`; A1 (`constants.ts`, `decode.ts`): + `test/stage.test.ts`, `test/plan.test.ts`; A6 (`beat.ts`): + `test/mixer.test.ts`; A3 (`samples.ts`): + `test/mixer.test.ts` | Ні |
| **Фінал — усе злито** | **`pnpm test` + `pnpm typecheck` + `pnpm lint`** | **Так, один раз** |

Дослівно для агента:
- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на `main` до змін;
  якщо падало — не чіпай, лише зафіксуй у звіті.»
- «Фінальний прогін — це ворота перед деплоєм: поки він не зелений, ТЗ не вважається виконаним.»
- «Платні виклики (`LIVE=1`) у блоках заборонені; їх робить власник після злиття хвилі.»

## 8. Review і Definition of Done

- На блок: тести блоку зелені; `pnpm lint` чистий на змінених файлах; жодних правок поза файлами з карти §4;
  `MIX_VERSION` не змінено; нові константи — у модулі блоку; diff проти інтеграційної гілки читається за один
  прохід.
- На Крок 0: поведінка зведення побайтово та сама, що до нього, крім `MIX_VERSION` (перевірка: `renderSoundtrack`
  на фікстурі дає той самий WAV, що на `main`, після заміни версії в хеші).
- На все ТЗ: фінальний `pnpm test`, `pnpm typecheck`, `pnpm lint` зелені (або падіння підтверджено на `main`);
  живий прогін власника показує: `integratedLufs` −14 ±1, `truePeakDbtp` ≤ −1, `lowCorrelation ≥ 0.9` у
  зведенні, усі семпли кешу з `qc.ok = true`, у `music.json` є `keyDetected` і `barConfidence`.

## 9. Запуск у Claude Code

- Просто: окрема сесія Desktop на кожен блок (свій worktree автоматично), спершу одна сесія на Крок 0.
- CLI: `claude -w audio-a1`, `claude -w audio-a2`, … у паралельних терміналах.
- Субагенти в одній сесії: `isolation: worktree` у `.claude/agents/*.md` або «use worktrees for your agents».
- Стеля 3–4 паралельних потоки: A10, A8, A9, A11 — короткі, їх варто взяти першими; A4 і A6 — найдовші.
- Свіжий worktree потребує `pnpm install` (у worktree немає `packages/*/node_modules`); після merge —
  `git worktree remove`.

## 10. Статус виконання (2026-10-13)

Крок 0 (PR #19) і хвиля 1 A1–A12 (PR #20) злиті в `main`. Аудит критеріїв приймання §2–§3 проти коду — жодного
невиконаного критерію.

**Фінальний прогін (§7):** `pnpm typecheck` і `pnpm lint` (481 файл) — зелені; `pnpm smoke` — зелений; `pnpm test` —
усі пакети зелені, крім одного тесту поза скоупом: `tests/integration/test/eval-run.test.ts` → «`--from render`
перезапускає рендер…» (`usdByProvider` порожній замість `["remotion"]`). Падає так само на `main` до Кроку 0
(`f25bc1a`), тож за правилом §7 не чіпався.

**Свідомі відхилення від формулювань ТЗ:**
- A3: поріг «повністю моно» для `whoosh`/`swoosh`/`riser` — `correlation < −0.2`, для решти — `< 0.3`
  (`samples.ts`). Формулювання «для будь-якого cue < 0.3» суперечить тесту самого A3 (whoosh із corr ≈ 0 лишає верх
  стерео) і порогам QC з A2.
- A6: оцінка фази такту бере силу онсетів 1–4 кГц (а не енергію) і додатковий член «доля 1 гучніша за долю 3» —
  без нього бочка на 1 і 3 не розрізняє долі 1 і 3; `trackSignals.barGroove` має акцент на долі 1, рівний метроном
  дає низьку впевненість (лише фаза долі).
- A8: riser в останній сцені обмежений `durationFrames − 1` (не виходить за кінець ролика).
- A4: `masterize` робить до 3 проходів «підсилення → лімітер», щоб повернути гучність, зрізану лімітером
  (у межах ±12 дБ, детерміновано).
- A1: `sfxHash` не включає формат `mp3_44100_128` — хеші кешу до A1 не змінились; будь-який інший формат дає новий хеш.
- §4: `stage.ts` змінено в інтеграційному коміті хвилі (PCM-шляхи SFX, лог тональності) — необхідна зшивка блоків.

**Лишається власнику (платно або потребує реальних даних):** `pnpm audio-measure -- --project
QrsPgSOfm8mGSsIXhlYv6`; `LIVE=1 pnpm sfx-cache --regenerate-failed` і таблиця QC; ручна проба форматів A1
(`LIVE=1 pnpm --filter @adc/audio live`); живий прогін одного проєкту і порівняння `audio-measure` до/після з §1
(DoD §8: −14 ±1 LUFS, ≤ −1 dBTP, `lowCorrelation ≥ 0.9`, усі семпли `qc.ok`, `keyDetected` і `barConfidence`
у `music.json`).
