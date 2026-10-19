# Eval

`eval/sites.json` — список сайтів для `pnpm eval` (заповнює замовник: 6–8 реальних сайтів українською
та англійською з різних галузей). Порожній список — eval нічого не запускає.

Елемент списку — рядок з URL або об'єкт:

```json
[
  "https://coffee.example.com/",
  {
    "url": "https://dental.example.com/en/",
    "name": "dental-en",
    "formats": ["9:16", "16:9"],
    "language": "en",
    "photos": ["photos/dental-1.jpg"]
  },
  { "text": "Шиномонтаж на Сихові, працюємо щодня з 8:00", "photos": ["photos/tyres.heic"] }
]
```

| Поле | Що це |
|---|---|
| `url` | адреса сайту (або `text`, або обидва) |
| `text` | опис бізнесу вручну — ручний режим без сайту |
| `name` | назва теки результатів і рядка звіту (дефолт — з домену) |
| `formats` | `9:16`, `1:1`, `16:9` (дефолт `9:16`) |
| `language` | `uk` / `en` — якщо сайт має кілька мовних версій |
| `photos` | фото клієнта, шляхи відносно `sites.json` |

Результати: `eval/runs/<дата-час>/` (у `.gitignore`) — `report.md`, `report.json`, `sites/<сайт>/` (mp4,
постер, стіли, аркуші, розкадровка, QA, `sfx-plan.json`, `sound-sheet.json`, `review.json`) і `data/` (повні
дані проєктів для `--from`).

## Звукорежисер і рецензент: порівняння режимів

Режим звуку воркер eval бере з env, як решта `ADC_*`: `ADC_SFX_MODE` (`designer` — звук ставить
звукорежисер по готовій картинці, дефолт; `storyboard` — звук із розкадровки), `ADC_FILM_REVIEW`
(`on`/`off`), `ADC_REVIEW_MAX_ROUNDS` (0–2). Невалідне значення — `eval` зупиняється до старту з кодом 2.
Ті самі сайти в обох режимах:

```bash
LIVE=1 pnpm eval
ADC_SFX_MODE=storyboard ADC_FILM_REVIEW=off LIVE=1 pnpm eval
```

`report.md` прогону і `eval/out/<кейс>/report.md` мають таблицю «Звук і рецензія» по кейсах:

| Колонка | Звідки |
|---|---|
| `score`, вердикт, зауваження fix/sfx/music і critical/major/minor | `review.json` (остання рецензія ревізії) |
| `offBeat` | `sound-sheet.json`: події, що звучать, cue поза `GRID_SOUND_CUES`, \|зсув до долі\| ≥ 20 мс |
| `muted` | `sound-sheet.json`: події, вимкнені звукорежисером |
| важкі удари, старти поза тактом | `sound-sheet.json`: `HIT_SOUND_CUES`, що звучать; `sceneStarts[].onBar === false` |

«—» — файлу немає (режим `storyboard`/рецензію вимкнено або прогін до звукорежисера).

Перезапуск (`--from <етап> --run <прогін>`) знає і нові етапи: `sfx` (лише `ADC_SFX_MODE=designer`; далі
зведення й рецензія), `review` (з `--only` — лише оцінити готовий фільм, зокрема прогону `storyboard`).
`--from audio` ставить `audio{music}` у режимі `designer` (далі зведення за наявним `sfx-plan.json`) і
`audio{full}` у режимі `storyboard`.

## Тест Epidemic Sound

Порівняння каталогу Epidemic Sound з генерацією ElevenLabs на тій самій картинці (два сайти з
`eval/sites.epidemic.json` × дві комбінації). Провайдери — з env: `ADC_MUSIC_PROVIDER`, `ADC_SFX_PROVIDER`
(`elevenlabs` — дефолт, або `epidemic`). Невалідне значення — код 2 до старту; `epidemic` без
`EPIDEMIC_API_KEY` у кореневому `.env` — теж код 2. Провайдери фіксуються на ревізію (`pipeline.json`) і
йдуть у параметри кожного job `audio`.

1. Прогін 1 (музика Epidemic, SFX ElevenLabs) — повний пайплайн, рецензію вимкнено, щоб картинка
   між прогонами не змінилась:

   ```bash
   ADC_MUSIC_PROVIDER=epidemic ADC_SFX_PROVIDER=elevenlabs ADC_FILM_REVIEW=off LIVE=1 pnpm eval --sites eval/sites.epidemic.json
   ```

2. Прогін 2 (музика ElevenLabs, SFX Epidemic) — лише звукова гілка на картинці прогону 1 (`audio{music}` →
   зведення за `sfx-plan.json` прогону 1). `--from audio` скидає `audioPlanHash`, тож трек прогону 1 іншого
   провайдера не перевикористовується:

   ```bash
   ADC_MUSIC_PROVIDER=elevenlabs ADC_SFX_PROVIDER=epidemic ADC_FILM_REVIEW=off LIVE=1 pnpm eval --from audio --run <тека прогону 1>
   ```

`report.md` прогону й кейсу мають колонки «Музика», «SFX» і «Epidemic: трек / семплів / завантажень»
(«⚠ темп» — темп треку поза допуском ±10 BPM; «—» — Epidemic не використовувався або старі дані), а в
підсумку — рядок «Завантажень Epidemic за прогін: N (лічильник: M з 50)».

**Квота.** Безкоштовний тариф — 50 завантажень на ключ (трек, версія під тривалість, кожен семпл).
Локальний лічильник `downloads.json` зупиняє прогін на 45 (`epidemic_quota`); прапорця обходу немає.
Очікуваний бюджет обох прогонів — ≤ 30. Якщо прогін зупинився з `epidemic_quota`, далі не ганяти —
дивитись `downloads.json`.

**`ADC_EPIDEMIC_DIR`.** Лічильник і кеш завантажень живуть не в даних прогону, а в `ADC_EPIDEMIC_DIR`
(дефолт `<корінь checkout>/.data/epidemic`, відносний шлях — від кореня репо). У кожного worktree дефолт
свій, тож на час тесту виставте в кореневому `.env` абсолютний шлях, щоб прогони 1 і 2 (і будь-який
повтор) ділили один лічильник і один кеш семплів.
