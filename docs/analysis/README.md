# Порівняння ролика пайплайна з еталоном `one line.mp4`

Процедура етапу L ТЗ `docs/superpowers/specs/2026-10-12-showreel-parity-tz.md` (§6, §8). Контекст і перші
виміри: `2026-10-12-opus-chat-vs-pipeline.md`. Еталон: `one line.mp4` (Opus 5.5 у чаті, 16:9, 25 с,
120 BPM), лежить у власника (`opus-video-dump/`). Нижче `REF` — шлях до нього.

## 1. Прогін кейсу (лише власник, LIVE)

Кейс `webreportio-parity` в `eval/sites.json`: `https://webreportio.com/`, 16:9, мова `uk`, тривалість 25 с,
без відповідей власника (автозатвердження лише обирає формат і мову; на питання бренд-кіта відповідей немає —
оркестратор бере їхні `default`, як при натисканні «Затвердити» в чаті).

```bash
# ключі ANTHROPIC_API_KEY і ELEVENLABS_API_KEY — у кореневому .env
pnpm eval -- --case webreportio-parity --mode pipeline   # після злиття хвилі 1
pnpm eval -- --case webreportio-parity --mode agent      # після злиття хвилі 2 (стадія author)
```

`--mode` ставить `ADC_GENERATION_MODE` воркеру eval (він працює в тому ж процесі) на час прогону і
відкочує після. До хвилі 2 `agent` нічого не перемикає — у звіті кейсу це видно за `time.stages`
(є `author` чи `codegen`/`check`/`qa`/`fix`).

Кеш SFX прогону свій (`eval/runs/<прогін>/data/cache/sfx`): стандартні звуки подій генеруються наново, їхні
витрати йдуть у `costs-shared.jsonl` і в $ кейсу не входять. $ кейсу — це `costs.jsonl` проєкту.

## 2. Що лежить після прогону

| Файл | Що це |
|---|---|
| `eval/out/webreportio-parity/report.json` | звіт кейсу (останній прогін цього кейсу), схема нижче |
| `eval/out/webreportio-parity/report.md` | те саме таблицями |
| `eval/runs/<прогін>/report.{json,md}` | звіт прогону (режим генерації, усі сайти) |
| `eval/runs/<прогін>/sites/01-webreportio-parity/` | `landscape.mp4`, `soundtrack.wav`, `storyboard.json`, `audio-plan.json`, `music.json`, `qa.json`, стіли, аркуші, `case-report.json` |
| `eval/runs/<прогін>/data/` | повні дані проєкту (для `pnpm eval -- --from <етап> --run <прогін>`) |

Звіт кейсу (`report.json`):

- `cost` — $ за стадіями й провайдерами, кількість викликів LLM, токени (input / output / cache write /
  cache read) — з `costs.jsonl` від старту прогону;
- `time` — настінні хвилини, машинні хвилини і стадії (запуски, хвилини) — з `trace.jsonl`;
- `storyboard` — сцени, події, cue, `impactSlam` і ліміт `1 + ⌊с/6⌋` (25 с → 5), найбільше ударів у 3 с,
  `breakdown` у структурі музики, items і ролі (`eyebrow`, `status`, …);
- `music` — з `audio/<hash>/music.json`: `check` (`MusicTrackCheck`: bpm, онсети бочки, впевненість долі,
  провали, RMS по секундах, `ok`), `attempts`, `offsetMs`; для треків до A2 — `check: null` з поясненням;
- `audio` — рівні звуку і зворотний зв'язок ТЗ якості звуку: мастер з `audio.json`, тональність плану й
  треку, такт і стерео з `music.json` (див. §4, цілі — §7);
- `criteria` — критерії паритету з §8 (`ok`: true / false / null — не виміряно автоматично).

## 3. Картинка: контакт-листи 1 fps

ffmpeg — системний або зі збірки Remotion (той, що знаходить `findFfmpeg`: `ADC_FFMPEG` або
`node_modules/.pnpm/@remotion+compositor-<платформа>@*/node_modules/@remotion/compositor-<платформа>/ffmpeg`;
на macOS йому потрібен `DYLD_LIBRARY_PATH=<тека бінарника>`).

```bash
OURS="eval/runs/<прогін>/sites/01-webreportio-parity/landscape.mp4"
# 25 кадрів (1 fps) у сітку 5×5, кадр 384 px завширшки, з таймкодом
for f in "$REF:ref" "$OURS:ours"; do
  ffmpeg -y -i "${f%:*}" -vf "fps=1,scale=384:-1,drawtext=text='%{pts\:hms}':x=8:y=8:fontcolor=white:box=1:boxcolor=black@0.5,tile=5x5" \
    -frames:v 1 "sheet-${f##*:}.png"
done
ffmpeg -y -i sheet-ref.png -i sheet-ours.png -filter_complex vstack sheet-compare.png
```

Якщо у ffmpeg немає `drawtext` (збірка Remotion), приберіть цей фільтр — порядок кадрів у сітці зліва
направо, згори вниз, 1 кадр = 1 с.

Дивимось на аркуші (критерії §8, вручну — у звіті вони `ok: null`):

1. **Продукт у кадрі**: є сцена з категоріями перевірки (`substance.checks`) і сцена з прикладом результату
   (проблема з оцінкою/серйозністю, рядки плану з оцінкою часу) — реальними рядками, а не сірими смужками.
2. **Живий фон**: у кожній сцені фон рухається (свічення, сітка, зерно; `Backdrop variant="stage"`), на
   проблемній сцені — відтінок `danger`.
3. **Розмаїття макету**: жодні дві сусідні сцени не мають той самий контейнер на тому самому місці без видимої
   трансформації між ними.

Для 9:16 той самий рецепт дає вузькі кадри — для порівняння з еталоном беремо лише 16:9.

## 4. Звук: метрики

Наш ролик — секція `audio` звіту кейсу (рахується з `soundtrack.wav`, без мережі й ключів):

- `audio.source = "stems"` — звіт повторив зведення стадії `audio` з артефактів (трек з `public/`,
  тональність з `audio-plan.json`, семпли SFX з кешу, розкадровка → `renderSoundtrack`) і результат
  **побайтно** збігся з `soundtrack.wav`; рівні музики й подій — зі стемів (`stems.music`, `stems.events`,
  після A1 ще `stems.reverb`), музика приведена до рівня міксу множником мастера;
- `audio.source = "mix"` — стеми відтворити не вдалося (причина в `audio.note`: немає треку, змінились
  промпти SFX/алгоритм зведення тощо), метрики — оцінка по готовому міксу (музика й події разом);
- `audio.source = null` — `soundtrack.wav` немає (прогін не дійшов до звуку), причина в `audio.note`.

| Поле | Визначення |
|---|---|
| `audio.mix` | RMS, пік, 90-й перцентиль RMS у вікнах 100 мс, RMS по секундах — dBFS |
| `audio.beat` | онсети бочки (низи < 150 Гц), онсетів на долю і впевненість фази долі при BPM розкадровки |
| `audio.music.outsideEvents` | RMS музики по секундах, де немає подій (зона події — від її вікна до кадру + 1¼ долі, ≥ 1 с; у режимі `mix` — до кадру + 2 с, riser — від −2 с), поза сценами з `mix: filtered/breakdown` і без останньої секунди (fade-out); `minDb` — критерій |
| `audio.events.list[].overMusicDb` | пік події у її вікні чутності (100 мс; riser — до кадру, whoosh — навколо) над RMS музики за секунду до кадру, дБ; `maxOverMusicDb` — критерій |
| `audio.integratedLufs`, `audio.truePeakDbtp`, `audio.masterGainDb` | мастер зведення з `audio.json` (`mix`): інтегральна гучність BS.1770-4, true peak (4× оверсемплінг) і підсилення мастера; null — зведення до ТЗ звуку |
| `audio.musicGainDb` | підсилення музики до рівня міксу (лише при `source = "stems"`); до ТЗ звуку це поле звалося `masterGainDb` |
| `audio.mixLowCorrelation` | кореляція L/R `soundtrack.wav` нижче 150 Гц (1 — моно); критерій моно-сумісності басу |
| `audio.keyPlanned`, `audio.keyDetected` | тональність з `audio-plan.json` і визначена за треком (`music.json` → `check.keyDetected`: `root` C = 0 … B = 11, `minor`, `confidence`) |
| `audio.barConfidence`, `audio.stereoCorrelation`, `audio.lowCorrelation` | з `check` у `music.json`: впевненість сильної долі (такту), кореляція L/R сирого треку — уся і нижче 150 Гц |
| `audio.attempts`, `audio.offsetMs` | генерацій треку і зсув вікна відео в сирому треку, мс (`music.json`; ті самі, що в `music`) |

Еталон міряється тими самими функціями:

```bash
ffmpeg -y -i "$REF" -vn -ac 2 -ar 44100 one-line.wav
pnpm eval -- --audio one-line.wav --bpm 120
# для симетрії — наш mp4 (має збігатися з soundtrack.wav):
ffmpeg -y -i "$OURS" -vn -ac 2 -ar 44100 ours.wav && pnpm eval -- --audio ours.wav --bpm <bpm розкадровки>
```

`--audio` друкує JSON: `levels` (як `audio.mix`) і `beat` (як `audio.beat`). Орієнтири еталону з аналізу:
RMS −12.4 dBFS, p90 100 мс −7.5 dBFS, 46 онсетів на сітці 0.5 с, RMS по секундах від −24 (breakdown) до −8
(удар). Стемів у еталона немає — «музика поза подіями» для нього оцінюється по секундах без ударів вручну.

## 5. Критерії паритету (§8) і де їх брати

| Критерій | Поріг | Джерело |
|---|---|---|
| Музика в міксі поза подіями | ≥ −16 dBFS | `criteria[music_level]` ← `audio.music.outsideEvents.minDb` |
| Піки подій над музикою | ≤ +6 дБ | `criteria[event_peaks]` ← `audio.events.maxOverMusicDb` |
| Трек без провалів, бочка на сітці | `MusicTrackCheck.ok = true` | `criteria[music_check]` ← `music.check.ok` |
| Гучність зведення | −14 ±1 LUFS | `criteria[loudness]` ← `audio.integratedLufs` |
| True peak зведення | ≤ −1 dBTP | `criteria[true_peak]` ← `audio.truePeakDbtp` |
| Низ зведення моно | кореляція L/R < 150 Гц ≥ 0.9 | `criteria[low_mono]` ← `audio.mixLowCorrelation` |
| impact/slam у розкадровці | ≤ 5 (25 с; загалом `1 + ⌊с/6⌋`) | `criteria[impact_count]` ← `storyboard.impactSlam` |
| Категорії перевірки і приклад результату в кадрі | є, з реальними рядками | контакт-лист (§3), `storyboard.roles` |
| Живий фон у кожній сцені | так | контакт-лист (§3) |
| Сусідні сцени не повторюють макет | так | контакт-лист (§3) |

Значення `ok: null` при наявному звуці означає «не виміряно» (напр. `music.check` немає в старому
`music.json` або мастера немає в старому `audio.json`), а не «виконано».

## 6. Таблиця $ і хвилин

Після кожного режиму перенесіть у таблицю §8 ТЗ: `$` — `cost.usd`, `хв` — `time.wallMinutes` (машинні —
`time.machineMinutes` у примітці), `Токени` — `cost.tokens.total` (input + output + cache write + cache read),
у примітку — назву прогону (`run`) і `criteria`, що не пройшли.

## 7. Звук: замір `pnpm audio-measure` і цілі якості

Інструмент приймання ТЗ `docs/superpowers/specs/2026-10-13-audio-quality-tz.md` — без мережі й ключів, читає
сховище лише на читання. Декодує через ffmpeg зі збірки Remotion (`decodeAudio`).

```bash
# ревізія проєкту: сирий трек music.mp3, обрізаний music.wav, soundtrack.wav, рендери mp4
pnpm audio-measure -- --project <id> [--rev n]
# з основного checkout (worktree має свій .data)
pnpm audio-measure -- --project <id> --data-dir "<основний checkout>/.data"
# будь-які файли: наш прогін і еталон поруч — у кінці зведена таблиця
pnpm audio-measure -- "eval/runs/<прогін>/sites/01-webreportio-parity/soundtrack.wav" "$REF"
# усі семпли кешу SFX: тривалість, onset, якір, пік, pitch, кореляція, QC
pnpm audio-measure -- --sfx-cache
```

На кожен файл друкує інтегральний LUFS (BS.1770-4) і short-term/momentary max, true peak dBTP, пік і RMS
dBFS, crest, кореляцію L/R (усю і нижче 150 Гц), енергію смуг 20 Гц–20 кГц відносно загальної (смуга 16–20k
показує, чи не зрізано верх) і RMS по секундах.

Цілі (§8 ТЗ; у звіті кейсу — `criteria[loudness|true_peak|low_mono]`, §5):

| Що | Ціль | Де дивитись |
|---|---|---|
| Інтегральна гучність `soundtrack.wav` | −14 ±1 LUFS | `audio-measure` (LUFS інтегр.), `audio.json` → `mix.integratedLufs` |
| True peak `soundtrack.wav` | ≤ −1 dBTP | `audio-measure` (true peak), `audio.json` → `mix.truePeakDbtp` |
| Низ зведення в моно | кореляція L/R < 150 Гц ≥ 0.9 | `audio-measure` (`corr<150`), `audio.mixLowCorrelation` |
| Семпли кешу SFX | QC `ok` у кожного | `audio-measure -- --sfx-cache`, колонка `QC` (`✗` — причини; `—` — семпл до A2) |
| Трек | `keyDetected` і `barConfidence` не null | `music.json` → `check`, `audio.keyDetected`, `audio.barConfidence` |

Порядок заміру після злиття хвилі (власник): `audio-measure` на `soundtrack.wav` і mp4 нового прогону —
порівняти з таблицею §1 ТЗ (LUFS, dBTP, кореляції, смуга 16–20k у mp4); `LIVE=1 pnpm sfx-cache
--regenerate-failed`, далі `audio-measure -- --sfx-cache` — усі рядки `QC ok`. Агент-автор бачить ті самі
числа треку в заголовку інструмента `audio_events` (темп, тональність плану й треку, LUFS, впевненість долі й
такту, ширина стерео).
