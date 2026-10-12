## Специфікація (затверджений дизайн)

### Потік

1. Клієнт вставляє URL (+ фото). API перевіряє URL і тип джерела, створює проєкт. Оркестратор ставить `crawl` → `brandkit`. У чаті прогрес («Сканую сайт… 7/25 сторінок») і лічильник витрат.
2. **Чекпоінт 1 — бренд.** Чат показує бренд-кіт (свотчі палітри, лого і до 4 кандидатів лого, шрифти, тон, послуги, гео, список фактів із джерелами) + 1–2 питання від Claude з дефолтами (ціль, оффер, CTA) + питання про формати (дефолт 9:16) + питання про мову відео, якщо на сайті кілька версій. Якщо придатних фото менше трьох — прохання дозавантажити. Клієнт відповідає, править бренд-кіт текстом, обирає інше лого або тисне «Затвердити».
3. `storyboard` → перевірка таймінгів і фактів → **Чекпоінт 2 — тексти.** Чат показує концепт, тексти сцен, таймінги, мініатюри обраних фото, музичний бриф. Цифри й обіцянки без джерела позначені. «Затвердити» підтверджує і їх (вони стають фактами від клієнта). Правки текстом → нова ревізія → чекпоінт 2 знову.
4. Паралельно: (а) `codegen` → `check` → (`fix` → `check`)* → `qa` → (`fix` → `check` → `qa`); (б) `audio`. Коли обидві гілки готові → **Чекпоінт 3 — розкадровка.** Стіли кожної сцени в основному форматі, зведені аркуші для інших форматів, попередження QA, плеєр із музикою. «Затвердити» або правки.
5. `render` обраних форматів → у чат MP4 + постер + розбивка витрат за етапами.
6. Правки після видачі: нова ревізія, перегенеруються лише зачеплені сцени, чекпоінт 3 зі стілами змінених сцен, потім рендер. Crawl, бренд-кіт і музика не перезапускаються, якщо їхні входи не змінились.

Основний формат — перший з обраних у порядку `vertical`, `square`, `landscape`.

### Стани і команди

Стани: `intake → crawling → brandkit → awaiting_brand → scripting → awaiting_script → directing → awaiting_storyboard → rendering → delivered`, а також `revising` (обробка правки на будь-якому чекпоінті або після видачі) і `failed` (з кнопкою «Спробувати ще раз»).

Команди від API до оркестратора (`PipelineCommand`): `start`, `user_message {text}`, `approve`, `set_logo {assetId}`, `photos_added {files}`, `retry`, `restart_confirmed`.

Правила:
- `project.json` пише лише оркестратор, під Redis-блокуванням `lock:project:<id>`. API і стадії його не змінюють.
- Повідомлення, яке прийшло в «зайнятому» стані (`crawling`, `brandkit`, `scripting`, `directing`, `rendering`, `revising`), зберігається. Чат відповідає шаблоном «Працюю над попереднім кроком, врахую на наступному погодженні», і повідомлення обробляється на найближчому чекпоінті.
- `restart` виконується лише після підтвердження кнопкою.
- Подвійні кліки: `jobId = <projectId>:<stage>:<rev>:<attempt>`; повторна команда `approve` в тому ж стані ігнорується.

### Артефакти проєкту (`DATA_DIR/projects/<id>/`)

- `project.json` — стан, формати, мова, відповіді, поточна ревізія, версія бренд-кіта.
- `uploads/` — оригінали фото клієнта.
- `crawl/{site.json,screenshots/,assets/,assets.json}`.
- `brandkit/v<k>.json` — кожна правка бренд-кіта дає нову версію.
- `audio/<planHash>/{music.mp3,music.json}`, `audio/sfx/` — аудіо, спільне для ревізій.
- `rev/<n>/` — усе, що залежить від сценарію: `storyboard.json`, `claims.json`, `video/scenes/<sceneId>.tsx`, `video/scenes/index.ts` (генерується кодом), `video/public/`, `video/bundle/`, `stills/<format>/<sceneId>-{a,b}.png`, `sheets/<format>.png`, `check.json`, `qa.json`, `pipeline.json` (лічильники спроб), `audio-plan.json`, `audio.json` (AudioManifest), `renders/<format>.mp4`, `poster.png`, `inputs.json` (хеші входів кожного артефакта).
- `costs.jsonl` — журнал платних викликів. `trace.json` — тривалість стадій і хеші промптів.

Нова ревізія = нова папка. Стадія пропускається, якщо в попередній ревізії є артефакт з тим самим хешем входів; тоді він копіюється. Файли автоматично не видаляються.

Події чату (повідомлення, прогрес, чекпоінти, витрати) зберігаються не у файлі, а в Redis Stream `events:<projectId>` (Redis з AOF і томом).

### Краулер (`packages/crawler`, Playwright/Chromium)

- **Безпека URL:** перед стартом і на кожному редіректі — `assertPublicHttpUrl` (лише http/https, блок приватних, loopback, link-local адрес і метаданих хмари). Запити сторінки до приватних адрес обриваються через `page.route`.
- **Виявлення сторінок:** sitemap.xml + лінки з головної. Домен вважається тим самим з урахуванням `www` і без нього; інші піддомени не краулимо. Пріоритет за ключами в URL/анкорі (about, services, products, menu, pricing, portfolio, reviews, team, contact). Пропускаємо пагінацію, фільтри, календарі, файли.
- **Мовні версії:** визначаємо за `hreflang` і префіксами (`/uk/`, `/ua/`, `/en/`, `/ru/`). Краулимо лише версію введеного URL, решту записуємо в `languageVersions[]`.
- **Ліміти:** 25 сторінок, 120 с, 4 вкладки паралельно. Якщо завантажилась хоча б головна — йдемо далі з позначкою `partial`. Нуль сторінок → `crawl_failed`.
- **Перед зйомкою сторінки:** закрити cookie-банер і поп-апи (список типових кнопок згоди, приховати фіксовані оверлеї), увімкнути `prefers-reduced-motion`, прокрутити сторінку до кінця для lazy-load, дочекатися шрифтів.
- **Скриншоти:** не full-page. Перший екран 1440×900 для кожної сторінки; для головної ще до 2 екранів нижче.
- **Зі сторінки:** основний текст без шапки/футера (Readability); title/meta/og; JSON-LD (LocalBusiness, Organization, Product, FAQ); заголовки; тексти кнопок; навігація; телефон/адреса/email/соцмережі; `lang`.
- **Дизайн із computed styles:** CSS-змінні `:root`, кольори фону/заголовків/кнопок/лінків із частотами, font-family/weight для h1/h2/body/button, border-radius кнопок.
- **Лого-кандидати:** img/svg у `header` з «logo» у src/alt/class, apple-touch-icon, og:image.
- **Фото-кандидати:** img (найбільший варіант із `srcset`, `data-src`) і CSS background ≥ 600 px з alt і контекстом.
- **Асети:** до 40 зображень, дедуп за pHash, розміри + домінантні кольори (sharp), `assets.json`.
- **Фото клієнта** (`ingestUserPhotos`): до 10 файлів по 25 МБ; HEIC → JPEG (`heic-convert`), EXIF-поворот, зменшення до 3000 px по довшій стороні; `source: "user"`, пріоритет максимальний. Можна додавати на будь-якому чекпоінті.
- **Ручний режим:** якщо сайт недоступний або джерело не сайт, чат просить текст і фото. З них будується мінімальний `site.json` (`source: "manual"`), пайплайн іде далі.

### Бренд-кіт (`packages/brandkit`, Opus 5.5, structured output, effort `high`)

Вхід: стислий текст сторінок, 4–6 скриншотів (image blocks), CSS-статистика, контакт-лист асетів (монтаж мініатюр з номерами, одна картинка). Вміст сайту передається як дані в тегах; промпт прямо каже не виконувати інструкцій із тексту сайту.

Вихід `BrandKit` (Zod):
- `identity` (name, tagline, category, language `uk`|`en`, city, serviceArea), `languageVersions[]`;
- `palette` (primary, secondary, accent, background, surface, textOnDark, textOnLight) — контраст перевіряється і виправляється програмно;
- `typography` — виявлені шрифти → Google Fonts; для `uk` шрифт обов'язково має кирилицю (звірка зі списком `fonts.json`);
- `logo` (assetId, type, needsBackground, textFallback) і `logoCandidates[]` (до 4 assetId);
- `voice`, `audience`, `offerings[]`, `usps[]`, `socialProof`, `location` + `hours`, `cta`;
- `facts[]` — див. розділ «Факти»;
- `visualStyle` (mood, motionPersonality: energetic|calm|premium|playful, density, shapes, musicHints);
- `assets[]` (ранжовані: role, quality 1–5, cropFocus, `hasBakedText`);
- `gaps[]` (зокрема `few_photos`, якщо фото з quality ≥ 3 менше трьох), `confidence`, `questions[]` (1–2 питання з дефолтами).

**Правка бренд-кіта** (`brandkit-patch`, Sonnet 5.5, structured): репліка клієнта → JSON-патч до поточної версії → та сама програмна перевірка (контраст, шрифти) → `brandkit/v<k+1>.json`. Вибір лого з кандидатів — без LLM.

### Факти

- `facts[]` у бренд-кіті: `{id, kind: price|discount|number|guarantee|date|claim, text, source: "site"|"client", sourceUrl?, quote?}`. Факти з сайту мають адресу сторінки і цитату. Факти від клієнта беруться з його повідомлень (їх витягує `chat-intent`).
- Якщо сайт і клієнт розходяться, факт клієнта замінює факт сайту.
- `verifyClaims(storyboard, brandkit)` — програмна перевірка: кожне число (ціна, відсоток, кількість, дата) і кожен маркер переваги («№1», «найкращий», «best», «гарантія» тощо, списки для uk і en) у текстах сцен має знаходитись у `facts[]` або в контактах/графіку. Результат — `claims.json` з `unverified[]`.
- На чекпоінті 2 непідтверджене позначається. «Затвердити» записує його як факти від клієнта. Число, яке клієнт сам написав у правці, одразу є фактом від клієнта.

### Режисура (`packages/director`)

**Стадія `storyboard`** (Opus, structured, `xhigh`): `Storyboard` — concept, hook, fps 30, `scenes[]` {id, purpose, durationFrames, transitionFrames (0 = склейка), text {headline, sub, emphasis[]}, factIds[], assetIds, layoutIntent (зокрема `typographic` — сцена без фото), motionIntent, transitionIn, sfxCue, musicEnergy 0–1}, `musicBrief` {genre, mood, bpm, instrumentation, structure[]}, `copyRules` {maxCharsPerLine за форматом}. Тривалість обирає модель у межах 15–30 с; клієнт може змінити її на чекпоінті 2.

Після виклику — `normalizeStoryboard` (код, без LLM): загальна тривалість за `computeTimeline` у межах 450–900 кадрів (інакше пропорційне масштабування), сцена ≥ 45 кадрів, перехід ≤ третини коротшої сусідньої сцени, неіснуючі `assetIds` викидаються, довжина тексту звіряється з `copyRules`. Потім `verifyClaims`.

**Таймлайн** (`computeTimeline` у `packages/shared`, єдине джерело таймінгів): `durationFrames` сцени — довжина її послідовності; загальна тривалість = сума сцен − сума переходів. Повертає для кожної сцени `from`, `durationInFrames`, а також `totalFrames`. Ним користуються хост-композиція, аудіо-план, SFX і вибір кадрів для стілів.

**Стадія `codegen`** (Opus, streaming text, `xhigh`): system = `remotion.dev/system-prompt.txt` + API-дока `motion-kit` + еталонні приклади сцен + жорсткі правила. Перша генерація — один виклик, який повертає всі сцени окремими файлами `scenes/<sceneId>.tsx` (так ролик цілісний). У режимі правки — лише вказані сцени, решта подається як контекст «тільки для читання».

Контракт сцени: `export default function Scene(props: SceneProps)`; сцена малює лише картинку. Переходи, звук і порядок сцен — справа хоста. Картинки лише через `<BrandImage assetId>`; розкладка через `useFormat()`; уся анімація — функція від `useCurrentFrame()`.

**AST-guard** (у складі `codegen` і `fix`):
- імпорти лише з whitelist: `react` (без `useState`, `useEffect`, `useLayoutEffect`), `remotion` (лише `useCurrentFrame`, `useVideoConfig`, `interpolate`, `spring`, `Easing`, `AbsoluteFill`, `Sequence`), `@remotion/layout-utils`, `@remotion/shapes`, `@remotion/paths`, `@adc/motion-kit`;
- заборонені: `fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `Function`, динамічний `import()`, `require`, `process`, `globalThis`, `window`, `document`, `Math.random`, `Date`, `performance`, `setTimeout`, `setInterval`, `requestAnimationFrame`;
- заборонені стилі `transition` і `animation`, теги `img`, `video`, `audio`, `iframe`, `script`, `link`, `style`, `object`, `embed`, атрибут `dangerouslySetInnerHTML`, рядки з `http://`, `https://`, `//`.

**Стадія `check`** (CPU, без LLM):
1. типи: `typecheckScenes` через TypeScript compiler API проти типів `motion-kit`; помилки групуються по сценах;
2. bundle задачі (rspack, enableCaching, прогрітий кеш в образі);
3. стіли: кожна сцена окремо через композицію `ScenePreview`, 2 кадри (50% і 90% тривалості сцени), у всіх обраних форматах; runtime-помилка прив'язується до сцени;
4. програмні перевірки: компоненти `motion-kit` у QA-режимі пишуть у лог браузера рядки `ADC_QA {…}` (текст не вліз або досяг мінімального розміру, елемент за межами safe-зони, розтягнуте чи сильно збільшене зображення, низький контраст); лог збирається через `onBrowserLog`;
5. зведені аркуші `sheets/<format>.png` (монтаж стілів, одна картинка на формат).

Результат — `check.json` {compileErrors, runtimeErrors, autoIssues по сценах}.

**Стадія `fix`** (Opus, `high`): окремий виклик на кожну проблемну сцену (паралельно в межах стадії), на вході код сцени + помилки або зауваження. Ліміти: до 2 кіл фіксів компіляції/runtime; сцена, яка після цього не працює, замінюється на `TemplateScene`.

**Стадія `qa`** (Opus vision, structured): на вході зведені аркуші всіх обраних форматів + `autoIssues`. Вихід `qa.json`: issues[] {sceneId, format, severity, kind: clipped_text|outside_safe_area|low_contrast|overlap|empty_frame|off_palette|stretched_image|too_much_text|logo_distorted, fix}; verdict pass|fix. При `fix` — одне коло: `fix` зачеплених сцен → `check` → `qa` лише по змінених сценах. Для кожної сцени лишається версія з меншою кількістю серйозних зауважень. Що лишилось — показується як попередження на чекпоінті 3; остаточне рішення за людиною.

**Стадія `revise`** (Opus, `high`, structured): репліка клієнта на чекпоінті 2, 3 або після видачі → `RevisionPlan` {storyboardPatch (JSON Patch), scenesToRegenerate[] {sceneId, instruction}, musicChanged, durationChanged}. Далі `normalizeStoryboard` + `verifyClaims`; на чекпоінті 2 цього достатньо, після нього запускається `codegen` у режимі правки.

### `motion-kit` (`packages/motion-kit`) — публічний API, версія 0

API фіксується в Кроці 0 як версія 0. До кінця хвилі 2 його можна змінювати міні-PR власника (див. «Карта володіння»), після — заморожено.

- Для сцен: `ThemeProvider`/`useTheme` (токени з BrandKit, шрифти через `@remotion/google-fonts` з `subsets: ["latin","cyrillic"]` і лише потрібними weights), `useFormat()` → {format: "vertical"|"square"|"landscape", width, height, safe}, `SafeArea`, `FitText` (з мінімальним розміром шрифту), `KineticText` (preset: rise|fade|scale|highlight|typewriter; by: word|line), `Headline`, `Body`, `Pill`, `CTAButton`, `BrandImage` ({assetId, fit, focal, kenBurns, parallax, mask, radius}), `Logo`, `Backdrop` (solid|gradient|noise|shapes), `springs` (snappy|soft|premium), `easings`.
- Лише для хоста: `MusicTrack` (з fade-out), `Sfx`, `TemplateScene` (детерміновані шаблони hero|text|image|cta, вибір за `scene.purpose`), QA-режим (`ADC_QA`-логи).
- Типи: `SceneProps = {scene, brand, assets: Record<string, AssetRef>, durationInFrames}`; `MainProps = {brand, storyboard, format, assets, audio: AudioManifest, templateScenes: string[], qa?: boolean}`; `AssetRef = {src, width, height, focal}`.
- `packages/motion-kit/examples/*.tsx` — 4–5 еталонних сцен. Компілюються в тестах і підставляються в промпт `codegen`. Дока для промпта генерується з `.d.ts` скриптом `pnpm --filter @adc/motion-kit docs` у `packages/motion-kit/API.generated.md`.

### Аудіо (`packages/audio`)

- **`audio-plan`** (Sonnet 5.5, structured): з BrandKit + Storyboard + таймлайну → `AudioPlan`: `compositionPlan.chunks[]` (межі чанків = межі сцен за `computeTimeline`; сцени < 3 с зливаються з сусідніми; positiveStyles з брифу + "instrumental"; negativeStyles ["vocals","lyrics"]; contextAdherence "high"), `promptFallback`, `sfx[]` {cue, text, durationSeconds} (стандартні + до 3 кастомних). Назви брендів і артистів у промпт музики не потрапляють.
- **Музика:** `client.music.composeDetailed({compositionPlan, modelId: "music_v2_5", outputFormat: "mp3_44100_128"}, {timeoutInSeconds: 300})`; фолбек `music.compose({prompt, musicLengthMs, forceInstrumental: true})`. Якщо API відхиляє промпт і повертає запропоновану заміну — один повтор із нею. Кеш за хешем плану. Довжина = відео + 1000 мс.
- **Синхронізація:** лише по межах чанків і сцен. Сітки за BPM немає: генератор не гарантує темп і початок із сильної долі.
- **Повторне використання при правках:** якщо музичний бриф не змінився і нове відео не довше за трек — трек лишається і підрізається з fade-out. Інакше генерується заново.
- **SFX:** 8 стандартних cue (whoosh, pop, click, impact, shimmer, swoosh, riser, tick) генеруються раз на деплой (`scripts/sfx-cache.ts`) у `DATA_DIR/cache/sfx/<hash>.mp3`; кастомні — `client.textToSoundEffects.convert({text, durationSeconds 0.5–1.5, promptInfluence 0.6, modelId: "eleven_text_to_sound_v2"})`.
- Файли копіюються в `rev/<n>/video/public/` → `staticFile()`. Розміщення звуку на таймлайні робить хост. LUFS-нормалізація — поза демо.
- Кожен виклик ElevenLabs записує витрати (`ctx.cost.record`).

### Рендер (`packages/render` + `apps/remotion`)

- `RenderEngine`: `bundleJob({jobDir}) → {serveUrl}`, `renderStill({serveUrl, composition, inputProps, frame, format, out}) → {logs}`, `renderMedia({serveUrl, inputProps, format, out, onProgress}) → {durationMs}`, `close()`.
- Хост `apps/remotion`: аліас `@job/scenes` на `rev/<n>/video/scenes/index.ts`. Дві композиції:
  - `Main` — `calculateMetadata` (розміри з `props.format`, тривалість із `computeTimeline`), `TransitionSeries` зі сцен реєстру, `TemplateScene` для сцен зі списку `templateScenes`, `MusicTrack` і `Sfx` за таймлайном;
  - `ScenePreview` — одна сцена без переходів, для стілів і QA.
- `renderMedia`: codec h264, audioCodec aac, crf 18, x264Preset veryfast, `chromiumOptions.enableMultiProcessOnLinux: true`, `licenseKey` з env. Браузер через `openBrowser()` переюзується в межах задачі.
- Постер: кадр 50% сцени з `purpose: "cta"` (якщо немає — останньої сцени) в основному форматі.
- Кожен рендер формату записує витрати за ціною Remotion з конфігу.

### Оркестратор (`packages/pipeline`)

- Реалізує `PipelineDriver`: `handleCommand(cmd)` і `onStageDone(result)`. Усередині — чиста функція `nextStep(projectState, event) → {state, jobs[], events[]}`, яку легко тестувати.
- Тримає машину станів, лічильники спроб (`pipeline.json`), створення ревізій, з'єднання двох гілок перед чекпоінтом 3, чергу відкладених повідомлень.
- **`chat-intent`** (Sonnet 5.5, `low`, structured): вільний текст на чекпоінті → {kind: approve|answer|edit|question|restart|other, answers?, formats?, language?, brandEdits?, edits?, facts[]?, durationSeconds?}. `approve` повертається лише коли в повідомленні немає жодної правки.
- **`chat-reply`** (Sonnet): вільні відповіді на питання клієнта. Системні репліки — шаблони українською в `packages/shared/src/i18n/uk.ts`.
- Помилка стадії → стан `failed`, у чаті причина простими словами і кнопка «Спробувати ще раз».

### API + чат (`apps/api`, Hono)

- Тонкий шар: HTTP, SSE, завантаження файлів, статистика. Стан не змінює, лише ставить команди в чергу `pipeline`.
- **Авторизація:** HTTP Basic з паролем `APP_PASSWORD` на всі маршрути. Порожній пароль = без авторизації (локальна розробка).
- **Ендпоінти:** `POST /api/projects` (multipart: url або manualText, photos[]) → {id}; `POST /api/projects/:id/messages` {text}; `POST /api/projects/:id/commands` {type: approve|set_logo|retry|restart_confirmed, …}; `POST /api/projects/:id/uploads` (multipart); `GET /api/projects/:id/events` (SSE); `GET /api/projects/:id`; `GET /api/projects/:id/trace`; `GET /api/projects`; `GET /api/stats`; `GET /api/stats.csv`; `GET /stats`; `GET /files/*` (лише всередині `DATA_DIR`, захист від `..`).
- **Вхід:** `assertPublicHttpUrl` і `classifySource(url)`. Для `social`/`marketplace` — одразу відповідь «потрібен сайт або текст і фото», краулер не стартує. ID проєкту — випадковий (nanoid, 21 символ).
- **SSE:** події `message`, `progress`, `checkpoint`, `artifact`, `cost`, `state`, `error`. `id` події = ID запису в Redis Stream. При підключенні з `Last-Event-ID` — довантаження пропущеного (`XRANGE`), далі `XREAD`. Без заголовка — вся історія проєкту.
- **`public/index.html`:** стрічка повідомлень, поле вводу, input file, кнопки «Затвердити»/«Правки»/«Спробувати ще раз», клікабельні кандидати лого, аудіоплеєр, відео-прев'ю, рядок «Витрачено: $X.XX», посилання на `/stats`. Стилі — статичний CSS у `public/static/css`, JS — ES-модулі в `public/static/js` (віддає `GET /static/*`), без збірки.
- **`/stats`:** проста HTML-таблиця, див. «Облік витрат».

### Воркер (`apps/worker`, BullMQ)

| Черга | Що виконує | Concurrency |
|---|---|---|
| `pipeline` | команди й завершення стадій → оркестратор | 8 (послідовно в межах проєкту через lock) |
| `crawl` | `crawl`, `ingest` (фото клієнта) | 2 |
| `llm` | `brandkit`, `brandkit-patch`, `storyboard`, `codegen`, `fix`, `qa`, `revise` | 6 |
| `cpu` | `check` | 1 |
| `audio` | `audio` | 2 |
| `render` | `render` (один job на формат) | 1 |

- Реєстр `stages.ts`: назва стадії → функція `Stage` + черга (мапа `STAGE_QUEUE` з Кроку 0).
- Після кожної стадії воркер ставить у `pipeline` подію `stage_done` або `stage_failed`.
- `lockDuration` 10 хв для `cpu` і `render`, `maxStalledCount: 0` (завислий job не перезапускається мовчки, а стає `stage_failed`).
- Прогрес і події стадії → `ctx.emit` → Redis Stream проєкту.
- `renderStage` для обраних форматів через `RenderEngine`. Graceful shutdown.

### Облік витрат і статистика

- **Журнал:** один запис на кожен платний виклик у `projects/<id>/costs.jsonl` (один рядок JSON до 4 КБ, `appendFile`). Витрати поза проєктом (кеш SFX) — у `DATA_DIR/costs-shared.jsonl`.
- **Запис (`CostEvent`):** ts, projectId, rev, stage, phase (`first_delivery`|`revision`), source (`chat`|`eval`|`test`), provider (`anthropic`|`elevenlabs`|`remotion`), model, promptName, promptHash, effort, attempt, units ({input, output, cacheWrite, cacheRead} або {seconds} або {renders}), unitPrices (знімок цін на момент виклику), usd, exact (false, якщо обсяг невідомий, напр. обірваний стрім).
- **Ціни:** `config/prices.json` з датою перевірки. Стартові значення на 2026-10-06: Opus 5.5 — $4 вхід / $20 вихід / $5 запис кешу 5 хв / $0,20 читання кешу за 1 млн токенів; Sonnet 5.5 — $2 / $10 / $2,5 / $0,20; ElevenLabs музика $0,15 за хв, SFX $0,12 за хв; Remotion $0,01 за рендер. Поле `fixedMonthly` {remotion, elevenlabs, server} — порожнє, заповнює замовник.
- **Хто пише:** LLM-обгортка — автоматично для кожного виклику, включно з повторами, відмовами й обірваними стрімами; аудіо і рендер — самі через `ctx.cost.record`.
- **Лічильник у чаті:** після кожної стадії подія `cost` {totalUsd, stageUsd}. Разом із відео — розбивка за етапами.
- **`/stats` і `/api/stats`:** рядок на проєкт — дата, сайт, статус, формати, тривалість відео, вартість до першої видачі, вартість правок, разом, кількість правок, кількість фіксів, кількість сцен-шаблонів, машинний час до першої видачі, посилання на чат проєкту. Рядки дорожче `COST_TARGET_USD` (дефолт 3.5) позначаються; це лише позначка.
- **Підсумок:** загальна сума; середня, медіана, 90-й перцентиль і максимум на готове відео; «усі витрати / кількість готових відео» (з урахуванням покинутих проєктів); розбивка за етапами і провайдерами; окремо `eval`, `test` і «спільне». Якщо `fixedMonthly` заповнено — рядок повної собівартості.
- **`/api/stats.csv`:** та сама таблиця проєктів для вставки в Google Sheets.
- Агрегація — скануванням папок проєктів (`aggregateCosts`), без бази.

### Промпти (`prompts/`)

`chat-intent.md`, `chat-reply.md`, `brandkit.md`, `brandkit-patch.md`, `storyboard.md`, `codegen.md`, `code-fix.md`, `qa.md`, `revise.md`, `audio-plan.md`, `elevenlabs/sfx-cues.md`. Frontmatter: `model`, `effort`, `max_tokens`, `cache: true`. Тіло — Markdown з `{{var}}`; `loadPrompt(name, vars)` → {system, model, effort, maxTokens, hash}. Хеш пишеться в `costs.jsonl` і `trace.json`. У dev перечитується на кожен виклик.

### LLM-обгортка (`packages/shared/src/llm`)

`@anthropic-ai/sdk`; `thinking: {type: "adaptive"}`, `output_config: {effort}` явно; system-блоки з `cache_control: {type: "ephemeral"}`. Усі виклики з effort `high` і вище йдуть через стрім (`client.messages.stream` + `finalMessage()`), щоб не впиратися в таймаути; structured-відповідь розбирається за Zod-схемою з фінального повідомлення. Обмеження, яких structured output не гарантує (min/max, довжини), перевіряються кодом після відповіді; одна повторна спроба з текстом помилки. `stop_reason === "refusal"` → один повтор із пом'якшеним формулюванням, далі помилка стадії. Повтори на `RateLimitError`, `APIConnectionError`, 5xx — до 3 з backoff. Кожна спроба записує `usage` у журнал витрат.

### Спостережуваність і якість

- `trace.json`: стадії з часом початку, тривалістю, спробами, хешами промптів.
- `scripts/eval.ts`: пайплайн без чату на `eval/sites.json` (чекпоінти затверджуються автоматично, `source: "eval"`) → `eval/runs/<date>/` з відео, стілами і звітом: вартість і час на сайт, частка сцен, що скомпілювались із першої спроби, частка QA pass, частка сцен-шаблонів. Режим `--from <stage> --run <date>` перезапускає лише один етап зі збережених даних попереднього прогону.

