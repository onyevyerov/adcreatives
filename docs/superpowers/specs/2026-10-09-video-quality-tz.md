# ТЗ: якість відео — один автор фільму, спільний таймлайн картинки й звуку

Дата: 2026-10-09. Формат — parallel-ready: Крок 0 заморожує інтерфейси, далі блоки без спільних файлів.

## 1. Мета і контекст

Порівняли наш ролик (проєкт `fPTg-5kgdmOGK53H2CDez`, webreportio.com, 9:16, 22 с, $3.05) з роликом, який
Fable 5.1 зробив за одну сесію в репозиторії продукту (16:9, 25 с, 13 хв). Різниця не в моделі як такій,
а в тому, як побудований процес:

| | Наш пайплайн | Ролик-еталон |
|---|---|---|
| Хто пише фільм | 6 окремих викликів: anchor `high`, решта 5 паралельно на `medium`, кожна сцена бачить лише anchor | Один автор пише весь фільм за один прохід, сцени знають геометрію одна одної |
| Що автор знає про продукт | Вижимку бренд-кіта: тарифи, 4 переваги, 13 фактів | Весь текст лендингу: кроки, 6 типів проблем, план по тижнях, порівняння з агенцією, FAQ |
| Що можна показати в кадрі | Лише `headline`, `sub` і кнопку; іконки заборонені; макети UI — сірі смужки | Будь-які реальні тексти продукту, іконки, графіки, UI-макети |
| Ритм | Увесь текст на місці до 25% сцени, далі кадр стоїть (тариф ~4 с, фінал ~3.5 с) | Кожна сцена розвивається: лічильник, кільце, галочки, закреслення |
| Переходи | 5 фіксованих, анімувати вихід сцени заборонено | Морфи між сценами: поле → скан-лінія, картки → колонки to-do |
| Звук | ElevenLabs-підкладка (замір: усі 5 частин однакові в межах 0.5 дБ — план аранжування проігноровано) + 4 SFX на початку сцен, 3 з них на 19–38 дБ тихіші за музику | Один `timeline.json` читають і композиція, і аудіоскрипт; ~40 звукових подій точно в кадри візуальних подій; склейки на сильних долях; дроп, брейкдаун, фінальний удар |
| Перевірка | QA шукає лише дефекти на 3 кадрах сцени; не бачить концепт і `motionIntent` | Автор дивиться свої кадри й виправляє те, що виглядає погано |

Крім того, знайдено 4 баги: `conflicts()` у `packages/brandkit/src/facts.ts` вважає різні тарифи одним
фактом і видаляє ціни; SFX не нормалізовані за гучністю й без дакінгу; пресет `highlight` малює плашку під
кожним словом; краулер не розкриває акордеони (FAQ) і склеює текст блоків без пробілів.

**Рішення власника (2026-10-09):**
- Продукт — круті рекламні motion-відео для будь-кого. Рамку «малий бізнес, кінетична типографіка поверх фото»
  прибрати з усіх промптів. Правила-обмеження з таблиці в §2.10 прибрати назавжди.
- Музика — ElevenLabs (підкладка). Над нею — шар звукових подій за спільним таймлайном.
- **Уточнення 2026-10-12:** звуки подій — не синтез у коді, а бібліотека SFX, згенерована ElevenLabs
  (`prompts/elevenlabs/sfx-cues.md`: 10 `SoundCue` × 3 варіанти, спільний кеш, `LIVE=1 pnpm sfx-cache` раз на деплой).
- Модель — Opus 5.5, effort `high` для творчих стадій (storyboard, codegen, code-fix, QA).
- `audio-plan` — Opus 5.5 `high`, `brandkit-patch` — Sonnet 5.5 `high`; в обох `max_tokens` 16 000.
  Уже внесено у frontmatter до Кроку 0. B1 і B3 переписують тіло цих промптів, frontmatter не чіпають.
- Без eval і експериментів. Перевірка — живий прогін власником наприкінці (етап L).

**Що лишається незмінним:** guard коду (без мережі, без випадковості, без зовнішніх ресурсів), детермінований
рендер, «тільки правда» (тексти й цифри — з сайту, фактів і відповідей власника; перевірка тепер покриває всі
тексти в кадрі), читабельність і safe area, фінал на лого з CTA, чекпоінти власника, три формати з одного коду.

**Вартість і час:** пріоритет — якість. Codegen одним викликом на `high` — оцінка, не замір. Історичний ризик:
на `main` до PR #10 усі сцени одним викликом на `xhigh` двічі обрізались на 128 000 токенів. Прибрати ліміт
неможливо: `max_tokens` обов'язковий в API, а 128 000 — стеля виходу Opus 5.5, codegen уже на ній
(`codegen.md:4`). Модель `max_tokens` не бачить: thinking і код рахуються в один ліміт і оплачуються однаково,
тож при обрізанні оплачено все, а файлів може не бути. Захист у режимі `film` (B5):
- effort `high` (не `xhigh`);
- **task budget** (beta `task-budgets-2026-03-13`; модель бачить зворотний відлік і сама закінчує роботу
  в межах бюджету) — уже підключений (`Tuning.codegenTaskBudget`, `codegen.ts:366`), але вимкнений; для `film`
  дефолт 100 000 при `max_tokens` 128 000;
- salvage обрізаної відповіді: написані сцени зберігаються, догенеровуються лише відсутні.

Фактичні $ і хвилини фіксуємо в етапі L з `costs.jsonl` / `trace.jsonl`.

## 2. Крок 0 — заморожені інтерфейси (робиться першим, окремим PR)

Усі зміни схем — **адитивні з дефолтами**: старі `storyboard.json`, `claims.json`, `audio.json` мають парситись.
Поки Крок 0 не влитий у `main`, паралель не стартує.

### 2.1 Storyboard v2 — `packages/shared/src/schemas/storyboard.ts`

```ts
export const LayoutIntent = z.enum([ /* існуючі */, "custom" ]);

/** Роль тексту в кадрі (крім headline/sub). */
export const OnScreenRole = z.enum(["heading", "label", "item", "number", "badge", "caption", "quote", "button"]);

export const OnScreenText = z.object({
  /** Унікальний у межах сцени: t1, t2, … */
  id: z.string().regex(/^t\d{1,2}$/),
  role: OnScreenRole,
  text: z.string().min(1),
  /** Група для структури: колонка, рядок, список ("col:1 тиждень", "row:вартість"). */
  group: z.string().nullable().default(null),
  factIds: z.array(z.string()).default([]),
});
export type OnScreenText = z.infer<typeof OnScreenText>;

export const SoundCue = z.enum(["whoosh", "swoosh", "riser", "impact", "slam", "pop", "ding", "tick", "click", "shimmer"]);
export type SoundCue = z.infer<typeof SoundCue>;
export const SoundAccent = z.enum(["soft", "normal", "hard"]);
export type SoundAccent = z.infer<typeof SoundAccent>;

export const SceneEvent = z.object({
  /** Унікальний у межах сцени: kebab-case. */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  /** Локальний кадр сцени, коли подію видно (момент удару, появи, зміни). */
  at: z.number().int().min(0),
  /** Що відбувається в кадрі, 1 речення англійською — для codegen і QA. */
  what: z.string(),
  sound: z.object({ cue: SoundCue, accent: SoundAccent.default("normal") }).nullable().default(null),
  /** Тексти з items, які з'являються або змінюються в цей момент. */
  textIds: z.array(z.string()).default([]),
});
export type SceneEvent = z.infer<typeof SceneEvent>;

// Scene: додати
//   items: z.array(OnScreenText).default([]),
//   events: z.array(SceneEvent).default([]),
// sfxCue лишається (deprecated): normalize перетворює його на подію "arrive" з at = 0.

export const MusicMix = z.enum(["filtered", "full", "breakdown"]);
// MusicBrief.structure[]: додати  mix: MusicMix.default("full")

/** Темпи, за яких доля — ціле число кадрів при 30 fps (1800 / bpm). */
export const BPM_GRID = [60, 72, 75, 90, 100, 120, 150] as const;
```

### 2.2 Таймлайн — `packages/shared/src/timeline.ts`

```ts
export function beatFrames(bpm: number, fps = 30): number;            // (60 * fps) / bpm
export function snapBpm(bpm: number): (typeof BPM_GRID)[number];      // найближчий з BPM_GRID

export interface EventPlacement {
  sceneId: string;
  eventId: string;
  /** Глобальний кадр моменту події = timeline.scenes[i].from + event.at. */
  frame: number;
  cue: SoundCue | null;
  accent: SoundAccent;
}
/** Усі події фільму в глобальних кадрах, відсортовані. Legacy sfxCue → подія "arrive" на from сцени. */
export function computeEventPlacements(sb: Pick<Storyboard, "fps" | "scenes">): EventPlacement[];

/** Локальний кадр події сцени; кидає Error, якщо id немає (рендер впаде → check/fix). */
export function eventFrame(scene: Pick<Scene, "id" | "events">, id: string): number;

/** Кадри стрічки для QA: step, 2·step, … (< duration − 1) і останній кадр. Кадр 0 не береться. */
export function stripFrames(durationInFrames: number, step?: number /* 15 */): number[];
```

`computeSfxPlacements` і `STILL_PLAN` не змінюються.

Семантика `frame` для звуку: це момент, коли подію видно. Аудіодвигун сам підводить звук: `riser`
закінчується на `frame`, `whoosh`/`swoosh` мають пік на `frame`, решта починаються з `frame`.

### 2.3 Тексти в кадрі — новий `packages/shared/src/screen-texts.ts` (+ експорт з `index.ts`)

```ts
/** Точні рядки, які дозволено показати в кадрі сцени: headline, sub, items[].text, brand.cta.text. */
export function allowedScreenTexts(scene: Pick<Scene, "text" | "items">, brand: Pick<BrandKit, "cta">): string[];
```

### 2.4 Claims — `packages/shared/src/schemas/claims.ts`

- `Claim.field`: `z.enum(["headline", "sub", "item"])`.
- `Claim.itemId: z.string().nullable().default(null)` — id з `items`, коли `field === "item"`.
- `Claim.matchedSite: z.boolean().default(false)` — число чи обіцянка знайдені дослівно в тексті сайту.

### 2.5 Аудіо — `packages/shared/src/types/video.ts`, `packages/shared/src/schemas/audioPlan.ts`

- `AudioManifest.mix: z.object({ src: z.string(), durationMs: z.number().int() }).nullable().default(null)`.
  Якщо `mix` не null, хост грає лише його: музика, події, дакінг і мастер уже зведені.
- `AudioPlan.key: z.string().nullable().default(null)` — тональність треку («A minor»), для висоти тону подій.

### 2.6 QA — `packages/shared/src/schemas/qa.ts`

- `AutoIssueKind` += `"static_hold"`, `"event_unused"`.
- `QaIssueKind` += `"static_hold"`, `"placeholder"`, `"dead_half"`, `"weak_moment"`, `"off_brief"`, `"text_too_fast"`.
  `late_text` і `too_much_text` лишаються в enum для старих даних; нові промпти їх не використовують.

### 2.7 Шляхи — `packages/shared/src/storage/paths.ts`

- `projectPaths(id).siteText` = `brandkit/site-text.txt` — стиснений текст сайту, який бачив бренд-кіт.
- `revPaths(id, n).strip(format, sceneId, frame)` = `strips/<format>/<sceneId>-<frame>.png`.
- `revPaths(id, n).stripSheet(format, sceneId)` = `strips/<format>/<sceneId>.jpg`.

### 2.8 Перемикачі — `packages/shared/src/tuning.ts`

- `codegenMode: z.enum(["sequential", "fanout", "film"])` — значення `film` додати, **дефолт лишити `fanout`**:
  Крок 0 вливається в `main`, а режим `film` реалізує лише B5. Дефолт на `film` перемикає B5.
- `codegenRestEffort` — дефолт `"high"` (для правок підмножиною і salvage).
- `qaMaxRounds: z.number().int().min(0).max(3).default(2)`.
- Env-імена — за існуючою схемою `ADC_*` у тому ж файлі.

### 2.9 Сигнатури в director (без зміни поведінки)

- `packages/director/src/guard.ts`: `guardScene(code, opts?: { allowedTexts?: readonly string[] })`.
  У Кроці 0 параметр ігнорується; перевірку реалізує B5.
- `prompts/code-fix.md`: додати в user-блок `<readonly_scenes>{{readonlyScenes}}</readonly_scenes>`;
  `packages/director/src/stages/fix.ts` передає `readonlyScenes: "-"`. Наповнення — B6.
- `packages/shared/test/prompts.test.ts`: у тест `code-fix` додати `readonlyScenes`.

### 2.10 Текстові контракти (не код; блоки вносять у свої промпти дослівно)

**Вступ студії (англійською, перший абзац кожного промпта замість «small businesses…»):**

> You work at a studio that makes advertising motion-graphics videos, 15–30 seconds, for any product or business:
> SaaS and apps, services, shops, venues, personal brands. The bar is the centrepiece of a motion designer's
> showreel: a video that shows the product at work, makes its strongest points unforgettable, and moves picture
> and sound as one. Everything on screen is real: texts, numbers and claims come from the client's website and
> the owner's answers; nothing is invented.

**Правила, які прибираємо назавжди:**

| Правило | Де зараз | Хто прибирає |
|---|---|---|
| Рамка «small businesses: kinetic typography over photos» | `brandkit.md:9`, `storyboard.md:8`, `codegen.md:10-14`, `audio-plan.md:8`, `qa.md` | B1, B4, B5, B3, B6 |
| «One offer… A video that tries to cover the whole site says nothing» | `storyboard.md:43` | B4 |
| В кадрі лише `headline`/`sub`/кнопка; headline 2–6 слів, sub ≤ 8 | `storyboard.md:56,63,122`; `codegen.md:44` (Rule 6) | B4, B5 |
| Заборона іконок та ілюстрацій | `storyboard.md:122`, `codegen.md:80` | B4, B5 |
| Текст на місці до 20–25% сцени; `late_text`, `too_much_text` | `storyboard.md:131`, `codegen.md:95`, `qa.md` | B4, B5, B6 |
| Сцена — ізольований компонент; вихід не анімувати; один-два типи переходів | `storyboard.md:112,141`, `codegen.md:98,110-136` | B4, B5 |
| «Simplest reliable form… a repair round costs money»; винахідливість на останньому місці | `codegen.md:142-150` | B5 |
| 2–4 SFX лише на початку сцени; музика — «рівна підкладка» | `storyboard.md:149-151`, `audio-plan.md` | B4, B3 |
| Ліміти «3–8 offerings», «2–5 usps» | `brandkit.md:92,94` | B1 |
| Fan-out codegen з `medium` | `tuning.ts:13-15` | Крок 0 (effort → `high`), B5 (режим → `film`) |

**Що лишається як правило:** тексти й цифри — тільки реальні; кожен текст у кадрі видно щонайменше
`max(1 s, 0.3 s × слів)` і він не тікає, поки його читають; safe area; фінал — лого і CTA; guard коду.

**Контракт motion-kit (реалізує B2, на нього посилаються промпти B5):** назви і мінімальні пропси нижче
заморожені, B2 може лише додавати необов'язкові пропси.

```ts
type IconName = /* ≥ 70 іконок lucide, обов'язково: check, x, alert-triangle, alert-circle, info, shield-check,
  lock, search, globe, link, mouse-pointer-2, settings, bell, plus, minus, arrow-right, arrow-up-right,
  chevron-right, refresh-cw, download, upload, play, file-text, file-check, clipboard-list, list-checks,
  bar-chart-3, pie-chart, trending-up, trending-down, gauge, target, layers, layout-grid, clock, timer,
  calendar, zap, rocket, dollar-sign, percent, tag, credit-card, wallet, gift, shopping-cart, shopping-bag,
  package, truck, users, user, message-circle, mail, phone, star, heart, thumbs-up, award, sparkles,
  map-pin, building-2, home, store, coffee, utensils, car, scissors, dumbbell, stethoscope, graduation-cap,
  camera, smartphone, monitor, code, bot */;
Icon(p: { name: IconName; size: number; color?: string; strokeWidth?: number; draw?: number /* 0..1 */; style?: CSSProperties })
numberIn(text: string): number | null            // перше число: "~50 перевірок" → 50, "від $300–2000" → 300
CountUp(p: { text: string; startFrame: number; durationFrames: number } & TextStyleProps)  // анімує перше число в text від 0
Ring(p: { segments: { value: number; color?: string }[]; startFrame: number; stagger?: number; size: number; thickness?: number; children?: ReactNode })
Bars(p: { values: number[]; startFrame: number; stagger?: number; width: number; height: number; direction?: "vertical" | "horizontal" })
UICard(p: { startFrame: number; children: ReactNode; accent?: string; style?: CSSProperties })
Checkbox(p: { checkedAt: number; size: number; color?: string })
Checklist(p: { items: string[]; startFrame: number; stagger?: number; checkFrom?: number; checkStagger?: number; width: number })
InputField(p: { text: string; placeholder?: string; typeStart: number; framesPerChar?: number; buttonLabel?: string; pressAt?: number; width: number; icon?: IconName })
Cursor(p: { path: { x: number; y: number; frame: number }[]; clickAt?: number })
ScanLine(p: { startFrame: number; durationFrames: number; from: number; to: number; axis?: "x" | "y"; thickness?: number })
Flash(p: { at: number; durationFrames?: number; color?: string; strength?: number })
Glow(p: { children: ReactNode; strength?: number; color?: string; pulse?: boolean })
Strike(p: { at: number; durationFrames?: number; color?: string; thickness?: number; children: ReactNode })
eventFrame  // реекспорт з @adc/shared/timeline
```

Текст усередині `InputField`, `Checklist`, `CountUp`, `UICard` іде через `FitText`, щоб працювали QA-логи
`text_overflow`. Значення для `Ring`/`Bars` код сцени отримує через `numberIn(item.text)`, а не літералами.

### 2.11 Фікстури (той самий PR)

`packages/shared/src/fixtures.ts`: в одну сцену додати 2–3 `items` і 2 `events` (один з `sound`, один без),
в одну частину `musicBrief.structure` — `mix: "breakdown"`. Синхронно оновити:
`apps/api/public/static/dev/fixture-events.js` (перевіряє `apps/api/test/ui/contracts.test.ts:77`),
`tests/integration/fixtures/llm/storyboard.json`, `packages/render/src/testing.ts`, а також літерали `Scene`
у тестах, які після зміни типу не проходять `pnpm typecheck` (за звітом: `director/test/{normalize,codegen,guard,
storyboard-copyfix}.test.ts`, `shared/test/timeline.test.ts`).

### Тести Кроку 0

- Нові тести в `packages/shared/test/`: round-trip старого storyboard без `items`/`events`; `snapBpm`,
  `beatFrames`; `computeEventPlacements` з переходами і legacy `sfxCue`; `eventFrame` кидає на чужий id;
  `stripFrames(60)`, `stripFrames(150)`; `allowedScreenTexts`; парсинг старого `claims.json` і `audio.json`.
- Команди: `pnpm --filter @adc/shared test`, `pnpm --filter @adc/api test`,
  `pnpm vitest run --project director packages/director/test/check-fix packages/director/test/fix-images packages/director/test/guard.test.ts`,
  `pnpm typecheck` (весь репо — ловить усі споживачі зміненого типу).

## 3. Блоки робіт

### Хвиля 1 — паралельно, 4 потоки (після Кроку 0)

#### B1: Контент — краулер і бренд-кіт

- **Володіє:** `packages/crawler/src/inpage/inpage.js`, `packages/crawler/src/inpage.ts`, `packages/crawler/src/crawl.ts`,
  `packages/crawler/test/**`, `packages/brandkit/src/**`, `packages/brandkit/test/**`, `prompts/brandkit.md`,
  `prompts/brandkit-patch.md`.
- **Залежить від:** Крок 0 (`projectPaths.siteText`).
- **Зробити:**
  1. Перед збором тексту розкрити згорнуте: `<details>` → `open = true`; клікнути `[aria-expanded="false"]`
     у межах `main`/`body` поза `header`/`nav`/`footer` (≤ 40 елементів, лише ті, що не ведуть на іншу сторінку);
     для `[role="tab"]` по черзі активувати кожну вкладку й зібрати текст панелі; чекати 300–500 мс після кліків.
  2. Блоковий текст замість склеєного: обхід DOM у порядку документа; заголовки — рядок `## …`, абзаци й пункти
     списків — окремі рядки, рядки таблиць — `клітинка | клітинка`. Між блоками завжди перенос рядка.
     Ліміт 20 000 символів на сторінку лишається. `PageData` не змінюється (поле `text` — рядок).
  3. Стадія бренд-кіта записує `projectPaths.siteText` — той самий стиснений текст `<page>…</page>`, який
     пішов у промпт бренд-кіта (`compressSiteText`, `input.ts:91`).
  4. `brandkit.md`, `brandkit-patch.md`: вступ студії з §2.10; прибрати ліміти «3–8» і «2–5» (брати все, що
     продає, у порядку сили); у `facts` збирати всі числа й твердження, включно з кроками процесу, кількістю
     перевірок/функцій, порівняннями з альтернативами дослівно («агенція: 3–10 робочих днів»), рейтингами й
     відгуками з цифрами. Пояснити, що сценарист тепер бачить і текст сайту, тож головна робота кіта —
     айдентика, факти й асети.
  5. Баг `conflicts()` (`facts.ts:208`): різні сутності з однаковим загальним словом не конфліктують.
- **Критерії приймання:**
  - Фікстурна сторінка з FAQ-акордеоном (відповідь рендериться лише після кліку) і `<details>`: текст відповідей
    є в `PageData.text`.
  - Між сусідніми блоками немає склеєних слів (`AuditКомплексний` неможливий).
  - `conflicts`: «Тариф Starter — $10/міс» vs «Тариф Pro — $40/міс» → false; «Капучино 65 грн» vs
    «Капучино 70 грн» → true; «Безкоштовна доставка від 500 грн» vs «від 400 грн» → true.
  - Після стадії бренд-кіта існує `brandkit/site-text.txt`.
- **Тести:** `packages/crawler/test/`, `packages/brandkit/test/` →
  `pnpm --filter @adc/crawler test` (потрібен Chromium) і `pnpm --filter @adc/brandkit test`.
- **Паралельність:** разом з B2, B3, B4.

#### B2: motion-kit — нові прийоми, іконки, фікс `highlight`

- **Володіє:** `packages/motion-kit/src/**` **крім** `src/host/audio.tsx` (його власник B3),
  `packages/motion-kit/API.md`, `API.generated.md`, `scripts/gen-docs.ts`, `examples/**`, `test/**`.
- **Залежить від:** Крок 0 (контракт §2.10, `eventFrame`).
- **Зробити:**
  1. Усі компоненти з контракту §2.10. Рух — чиста функція кадру (`spring`/`interpolate`), кольори — з теми.
  2. Іконки: шляхи lucide, вбудовані як дані (без нової runtime-залежності), ≥ 70 штук з обов'язковим списком;
     файл ліцензії ISC `packages/motion-kit/src/icons/LICENSE-lucide`. `draw` — промальовування штриха
     через `strokeDasharray`.
  3. `highlight` (`src/text/TextBlock.tsx:154-177`): одна плашка на фразу з `emphasis`, а не на кожне слово;
     внутрішній відступ, щоб виносні елементи («д», «у») не торкались краю.
  4. Новий приклад `examples/ui-demo.tsx`: сцена з `InputField` → `ScanLine` → `Checklist` + `CountUp`,
     усі моменти через `eventFrame`, тексти лише з `props.scene.items`. Додати в `examples/index.ts`;
     тест «їх 4–6» оновити до 4–7.
  5. `API.md`: розділ про нові прийоми з короткими правилами (числа — через `numberIn`, тексти — з `items`).
     Перегенерувати `API.generated.md`: `pnpm --filter @adc/motion-kit docs`.
- **Критерії приймання:** кожен компонент рендериться детерміновано (один кадр двічі → однаковий результат);
  `Checkbox` до `checkedAt` порожній, після — з галочкою; `CountUp` на останньому кадрі показує `text` дослівно;
  `Icon` з невідомою назвою не компілюється (тип); приклади компілюються; `highlight` дає один прямокутник на фразу.
- **Тести:** `packages/motion-kit/test/` →
  `pnpm --filter @adc/motion-kit test` і `pnpm vitest run --project director packages/director/test/typecheck.test.ts`.
- **Паралельність:** разом з B1, B3, B4. Зливається **першим** у хвилі (B5 читає `API.md`).

#### B3: Звук — ElevenLabs-підкладка + шар подій + зведення

- **Володіє:** `packages/audio/src/**`, `packages/audio/test/**`, `prompts/audio-plan.md`,
  `prompts/elevenlabs/sfx-cues.md`, `packages/motion-kit/src/host/audio.tsx`, `apps/remotion/src/compositions.tsx`.
- **Залежить від:** Крок 0 (`computeEventPlacements`, `beatFrames`, `MusicMix`, `AudioManifest.mix`, `AudioPlan.key`).
- **Зробити:**
  1. **Музика:** ElevenLabs `music_v2_5` як зараз. `audio-plan.md`: вступ студії; темп — `musicBrief.bpm`
     (уже з `BPM_GRID`); одна тональність у полі `key`; стабільний грув і тембр на весь трек. Арку
     (вступ/повна/брейкдаун) робить наше зведення, бо генератор план аранжування ігнорує (замір: 5 частин
     однакові в межах 0.5 дБ).
  2. **Вирівнювання долі:** декодувати mp3 у PCM (ffmpeg зі збірки Remotion — фільтри в ній урізані, тому
     вся обробка звуку — у Node на PCM), знайти онсети бочки в низах, оцінити фазу відносно сітки
     `beatFrames(bpm)` і зсунути трек (обрізати початок або додати тишу), щоб долі лягли на сітку ±1 кадр.
  3. **Автоматизація частин** за `musicBrief.structure[].mix`: `filtered` — low-pass ~800 Гц і −4 дБ;
     `full` — без змін; `breakdown` — low-pass ~400 Гц і −10 дБ. Рампи довжиною в одну долю на межах.
     Остання секунда — fade-out.
  4. **Шар подій** (уточнено 2026-10-12): семпли з бібліотеки SFX ElevenLabs — 10 `SoundCue` × 3 варіанти
     у `prompts/elevenlabs/sfx-cues.md`, спільний кеш `cache/sfx/`, прогрів `LIVE=1 pnpm sfx-cache`; при промаху
     кешу стадія догенеровує. Варіанти cue — по колу. Семпл обрізається й ставиться якорем на кадр (§2.2).
     `pop`/`ding`/`shimmer` — висота оцінюється й зсувається до тональності `key` (якщо не розпізнано —
     ля-мінорна пентатоніка); послідовні `pop`/`ding` в одній сцені йдуть угору по звукоряду.
     `accent` → гучність (soft/normal/hard). Розміщення — `computeEventPlacements` із семантикою §2.2.
     Немає семпла cue — подія без звуку (warn), зведення будується.
  5. **Дакінг:** музика × `(1 − d·e^(−t/τ))` після `impact`/`slam`/кінця `riser` (d ≈ 0.5–0.6, τ ≈ 150 мс).
  6. **Мастер:** сума → нормалізація до RMS ≈ −14 dBFS → м'який кліпер, пік ≤ −1 dBFS →
     `rev/<n>/video/public/soundtrack.wav` (44.1 кГц, 16 біт, стерео). `AudioManifest.mix` заповнений.
     Хеш повторного використання включає `planHash` + події + таймлайн.
  7. **Хост:** у `host/audio.tsx` `MusicTrack` при `audio.mix` грає лише `soundtrack.wav` (без власного fade
     і гучності), `Sfx` при `audio.mix` повертає `null`. Нових експортів з `motion-kit/src/index.ts` не додавати
     (файл належить B2). У `compositions.tsx` — без змін логіки сцен.
- **Критерії приймання:**
  - На синтетичному «треку-метрономі» зі зсувом 70 мс після вирівнювання онсети на сітці ±1 кадр.
  - Кожна подія з `sound` чутна: пік події у вікні 100 мс ≥ RMS музики в тому ж вікні + 6 дБ.
  - `breakdown` тихіший за `full` щонайменше на 6 дБ RMS.
  - Той самий вхід → побайтно той самий `soundtrack.wav`.
  - Старий `audio.json` без `mix` грає як раніше.
- **Тести:** `packages/audio/test/` →
  `pnpm --filter @adc/audio test` і `pnpm --filter @adc/remotion typecheck`.
- **Паралельність:** разом з B1, B2, B4.

#### B4: Сценарій — storyboard, нормалізація, факти, ревізії, чекпоінт 2

- **Володіє:** `prompts/storyboard.md`, `prompts/storyboard-copyfix.md`, `prompts/revise.md`, `prompts/chat-reply.md`,
  `packages/director/src/stages/storyboard.ts`, `packages/director/src/normalize.ts`, `packages/director/src/claims.ts`,
  `packages/director/src/stages/revise.ts`, `packages/pipeline/src/checkpoints.ts`, `packages/pipeline/src/chat.ts`,
  `tests/integration/src/cli.ts`; тести: `packages/director/test/{storyboard-copyfix,storyboard-revise,normalize,claims}.test.ts`,
  `packages/pipeline/test/driver.test.ts`, новий `packages/pipeline/test/checkpoints.test.ts`.
- **Залежить від:** Крок 0 (схема v2, `snapBpm`, `beatFrames`, claims), B1 — лише через артефакт
  `brandkit/site-text.txt` (до злиття B1 — fallback, див. п. 2).
- **Зробити:**
  1. **`storyboard.md` переписати** за процесом еталона:
     - вступ студії;
     - вивчи продукт з `<site>` і `<brand>`;
     - обери 3–4 найсильніші сторони;
     - побудуй історію з причинністю (не «одна пропозиція»);
     - кожна сцена — кадри з реальними текстами в `items` (дослівно або скорочено без зміни чисел);
     - моменти — в `events` з кадрами і звуком: кожна поява, що має значення, — подія; орієнтир 12–40 подій на ролик;
     - `bpm` — з `BPM_GRID`; межі сцен — на долях; `musicBrief.structure[].mix`; брейкдаун перед фіналом
       дозволений і бажаний;
     - переходи: за замовчуванням `cut` з переходом, зробленим усередині сцен (морф, спалах, згортання);
       хостові переходи — коли справді потрібне перекриття;
     - іконки з motion-kit дозволені;
     - лишити правила з §2.10.
     
     Відповіді власника, як і раніше, мають пріоритет. Прибрати все з таблиці §2.10, що належить B4.
  2. `storyboard.ts`: нова змінна `{{site}}` — вміст `projectPaths.siteText`; якщо файла немає (старі проєкти) —
     `compressSiteText(site.json)` з `@adc/brandkit`.
  3. `normalize.ts`:
     - `bpm` → `snapBpm`;
     - тривалості сцен — кратні `beatFrames`, загальна довжина точна (остачу забирає остання сцена);
     - `events`: `at` у межах `[0, durationFrames − 1]`, дублікати id прибрати;
     - події з `cue` ∈ {impact, slam, whoosh, swoosh, riser, pop, ding, shimmer} — на найближчу восьму
       (`beatFrames / 2`); tick/click не знімати з місця;
     - `items`: trim, унікальні id, `factIds` — лише відомі;
     - legacy `sfxCue` → подія `arrive` з `at: 0`.
  4. `claims.ts`: перевіряти також `items` (`field: "item"`, `itemId`); новий параметр `siteText` —
     число чи обіцянка, знайдені дослівно в тексті сайту, → verified з `matchedSite: true`.
  5. `storyboard-copyfix.md`, `revise.md`, `revise.ts`: підтримати `items` і `events` (JSON-pointer шляхи,
     перегенерація сцени при зміні її `items`/`events`).
  6. Чекпоінт 2 (`checkpoints.ts:101-159`) і `cli.ts:129-141`: під рядком сцени — тексти з `items`
     (`· label · label`), непідтверджені твердження з `items` позначені ⚠. `chat.ts:81-92`: передати `items`.
- **Критерії приймання:**
  - На фікстурі нормалізація дає межі сцен кратні 15 кадрам при `bpm: 120` і точну загальну довжину.
  - `verifyClaims` знаходить «від $300–2000» в `items` і підтверджує його текстом сайту.
  - Старий storyboard без `items`/`events` проходить нормалізацію без змін текстів.
  - Чекпоінт 2 показує тексти `items`.
- **Тести:** `pnpm vitest run --project director packages/director/test/storyboard packages/director/test/normalize
  packages/director/test/claims` і `pnpm vitest run --project pipeline packages/pipeline/test/driver packages/pipeline/test/checkpoints`.
- **Паралельність:** разом з B1, B2, B3.

### Хвиля 2 — паралельно, 2 потоки (після злиття хвилі 1)

#### B5: Codegen — режим `film`: один автор, весь фільм за один виклик

- **Володіє:** `prompts/codegen.md`, `prompts/motion-reference.md`, `packages/director/src/stages/codegen.ts`,
  `packages/director/src/files.ts`, `packages/director/src/guard.ts`, `packages/director/src/context.ts`,
  `packages/shared/src/tuning.ts` (лише дефолти `codegenMode` → `film` і `codegenTaskBudget` → 100 000);
  тести: `packages/director/test/{codegen,codegen-fanout,guard}.test.ts`, новий `packages/director/test/codegen-film.test.ts`.
- **Залежить від:** Крок 0, B2 (`API.md` з новими прийомами), B4 (семантика `items`/`events` у промпті).
- **Зробити:**
  1. **Режим `film`** (після реалізації перемкнути дефолт `codegenMode` у `tuning.ts` на `film`):
     - один stream-виклик з effort `codegenAnchorEffort` (`high`), `max_tokens` 128 000 і task budget
       `codegenTaskBudget` = 100 000 (дефолт перемкнути в `tuning.ts`; механізм уже є, `codegen.ts:366`);
     - у промпті сказати, що бюджет на весь фільм обмежений: спершу коротко спроєктувати фільм, потім писати
       сцени по порядку, не переписуючи вже написане;
     - prompt mode `film`, `targets` — усі сцени;
     - відповідь — усі `<file name="sN.tsx">`.
     
     **Salvage:** якщо `stop_reason = max_tokens` або частини сцен немає, валідні файли зберегти, а відсутні
     догенерувати режимом `continue`: по одній, з усіма вже написаними сценами в `readonlyScenes`, тим самим effort.
     Режими `fanout`/`sequential` лишаються як відкат через env.
  2. **`codegen.md` переписати.** Додати:
     - вступ студії;
     - спершу спроєктуй увесь фільм, потім пиши сцени як послідовні кадри одного фільму;
     - match-cut: кінцевий стан сцени N = початковий стан сцени N+1 (та сама геометрія, колір, позиція);
     - вихід сцени дозволено анімувати; переходи — всередині сцен (спалах, морф, згортання в лінію), хостовий —
       лише якщо так у storyboard;
     - кожен `events[].id` сцени керує своїм моментом через `eventFrame(props.scene, "id")`, бо звук стоїть
       саме на цих кадрах;
     - тексти в кадрі — лише `allowedScreenTexts` (headline, sub, `items[].text`, CTA), дослівно;
     - числа для графіків — через `numberIn`;
     - іконки — `Icon`; UI і дані — нові прийоми з `API.md`, але писати з нуля можна що завгодно;
     - читабельність за правилом §2.10.
     
     Прибрати все з таблиці §2.10, що належить B5. Rule 6 замінити на правило текстів вище.
     Нові змінні не додавати: тест `shared/test/prompts.test.ts` перевіряє набір змінних codegen.
  3. **`guard.ts`:** реалізувати `allowedTexts`. `JSXText` і рядкові літерали, передані дітьми JSX
     (`{"…"}`), з літерою чи цифрою мають точно збігатися з одним із дозволених рядків (або бути його
     підрядком). Інакше — порушення `screen_text`. Пунктуація й символи (`•`, `—`, `→`, `%` окремо) дозволені.
     Codegen передає `allowedScreenTexts(scene, brand)`.
  4. `brandForCode` (`codegen.ts:71-82`): додати `identity.tagline`.
- **Критерії приймання:**
  - На mock-LLM режим `film` робить один виклик і пише всі сцени; у виклик передано `taskBudget: 100000`.
  - Обрізана відповідь з 4 із 6 файлів → 4 збережено, 2 догенеровано `continue` з 4 сценами в readonly.
  - `guard` відхиляє `<div>Найкращий сервіс</div>`, якого немає в текстах сцени, і пропускає
    `{props.scene.items[0].text}` та `<span>•</span>`.
  - Хеш кешу codegen змінюється при зміні `items`/`events` сцени.
- **Тести:** `pnpm vitest run --project director packages/director/test/codegen packages/director/test/guard` і
  `pnpm vitest run --project shared packages/shared/test/prompts.test.ts`.
- **Паралельність:** разом з B6. Зливається першим у хвилі 2.

#### B6: Check, QA, fix — арт-директор замість пошуку дефектів

- **Володіє:** `prompts/qa.md`, `prompts/code-fix.md`, `packages/director/src/stages/check.ts`,
  `packages/director/src/sheets.ts`, `packages/director/src/stages/qa.ts`, `packages/director/src/stages/fix.ts`,
  `packages/pipeline/src/pipe.ts`, `packages/pipeline/src/machine.ts`, `packages/shared/test/prompts.test.ts`
  (лише тест `code-fix`); тести: `packages/director/test/{check-fix,fix-images,qa}.test.ts`, новий
  `packages/director/test/check-strip.test.ts`, `packages/pipeline/test/machine.test.ts`.
- **Залежить від:** Крок 0, B2 (нові прийоми у кадрах), B4 (`events` у сценах).
- **Зробити:**
  1. `check.ts`:
     - крім стілів `STILL_PLAN`, рендерити стрічку `stripFrames(duration, 15)` для кожної сцени в кожному
       обраному форматі (`ScenePreview`, `qa: true`) у `revPaths.strip`;
     - склеїти аркуш сцени `revPaths.stripSheet` (≤ 1568 px по довшій стороні) через `sheets.ts`.
  2. **Автодетектор `static_hold`:** різниця сусідніх кадрів стрічки (зменшених, наприклад, до 96 px по ширині);
     серія майже однакових кадрів ≥ 45 кадрів (1.5 с) → AutoIssue `static_hold` з діапазоном кадрів.
     Поріг — константа з тестом. Для фінальної сцени `cta` поріг — 75 кадрів.
  3. **`event_unused`:** кожен `events[].id` сцени має траплятися рядковим літералом у коді сцени,
     інакше — AutoIssue.
  4. **`qa.md` переписати:**
     - вступ студії;
     - арт-директор отримує `concept`, а по сцені — `motionIntent`, `items`, `events` (з секундами) і аркуш стрічки;
     - дефекти, що лишаються: `clipped_text`, `outside_safe_area`, `low_contrast`, `overlap`, `stretched_image`,
       `logo_distorted`, `empty_frame`;
     - майстерність: `static_hold`, `placeholder` (смужки чи порожні плашки там, де мав бути контент),
       `dead_half` (половина кадру порожня ≥ 2 с — major), `weak_moment` (момент події не видно або не читається),
       `off_brief` (сцена не робить того, що в `motionIntent`), `text_too_fast` (текст видно менше за §2.10).
     
     `late_text` і `too_much_text` прибрати. `fix` — конкретна інструкція.
  5. `qa.ts`: у промпт — аркуші стрічки замість трикадрових зображень; скорочений storyboard доповнити
     `concept`, `motionIntent`, `items`, `events`. Вердикт — як і раніше, кодом.
  6. `fix.ts` + `code-fix.md`:
     - `readonlyScenes` — код усіх інших сцен (контекст фільму);
     - зображення — аркуш стрічки сцени;
     - змінювати лише свою сцену, зберігати match-cut з сусідами, правила текстів і `eventFrame` — як у B5;
     - `guardScene` викликати з `allowedScreenTexts`;
     - `code-fix.md`: `max_tokens` 32 000 → 64 000, бо у вхід тепер іде код усього фільму.
     
     Прибрати згадки правила 25%.
  7. `machine.ts`/`pipe.ts`: кількість раундів QA → `Tuning.qaMaxRounds` замість константи `MAX_QA_ROUNDS`.
- **Критерії приймання:**
  - Сцена-фікстура, де після кадру 30 нічого не рухається 90 кадрів, → `static_hold`.
  - Сцена з подією, id якої немає в коді, → `event_unused`.
  - QA-промпт містить `concept` і `motionIntent`.
  - Fix отримує код інших сцен.
  - При `qaMaxRounds: 2` після двох раундів QA→fix пайплайн іде до чекпоінта 3.
- **Тести:** `pnpm vitest run --project director packages/director/test/check packages/director/test/qa
  packages/director/test/fix`, `pnpm vitest run --project pipeline packages/pipeline/test/machine` і
  `pnpm vitest run --project shared packages/shared/test/prompts.test.ts`.
- **Паралельність:** разом з B5.

## 4. Карта володіння файлами

- **Крок 0** → `packages/shared/src/schemas/{storyboard,claims,qa,audioPlan}.ts`, `packages/shared/src/types/video.ts`,
  `packages/shared/src/timeline.ts`, `packages/shared/src/screen-texts.ts` (новий), `packages/shared/src/index.ts`,
  `packages/shared/src/storage/paths.ts`, `packages/shared/src/tuning.ts`, `packages/shared/src/fixtures.ts`,
  `packages/shared/test/**` (нові тести; оновлення `prompts.test.ts` для `code-fix`),
  `packages/director/src/guard.ts` (лише сигнатура), `packages/director/src/stages/fix.ts` (лише змінна
  `readonlyScenes: "-"`), `prompts/code-fix.md` (лише рядок `readonly_scenes`),
  `apps/api/public/static/dev/fixture-events.js`, `tests/integration/fixtures/llm/storyboard.json`,
  `packages/render/src/testing.ts`, літерали `Scene` у тестах, що не проходять typecheck.
- **B1** → `packages/crawler/**` (src, test), `packages/brandkit/**` (src, test), `prompts/brandkit.md`, `prompts/brandkit-patch.md`.
- **B2** → `packages/motion-kit/**` крім `src/host/audio.tsx`.
- **B3** → `packages/audio/**`, `prompts/audio-plan.md`, `prompts/elevenlabs/**`, `packages/motion-kit/src/host/audio.tsx`,
  `apps/remotion/src/compositions.tsx`.
- **B4** → `prompts/{storyboard,storyboard-copyfix,revise,chat-reply}.md`, `packages/director/src/{normalize,claims}.ts`,
  `packages/director/src/stages/{storyboard,revise}.ts`, `packages/pipeline/src/{checkpoints,chat}.ts`,
  `tests/integration/src/cli.ts`, `packages/pipeline/test/{driver,checkpoints}.test.ts` і тести director з поля блоку.
- **B5** → `prompts/{codegen,motion-reference}.md`, `packages/director/src/{guard,files,context}.ts`,
  `packages/director/src/stages/codegen.ts`, `packages/shared/src/tuning.ts` (лише дефолти `codegenMode`
  і `codegenTaskBudget`, хвиля 2)
  і їхні тести.
- **B6** → `prompts/{qa,code-fix}.md`, `packages/director/src/sheets.ts`, `packages/director/src/stages/{check,qa,fix}.ts`,
  `packages/pipeline/src/{pipe,machine}.ts`, `packages/pipeline/test/machine.test.ts`, `packages/shared/test/prompts.test.ts`
  і тести director з поля блоку.
- **Спільні файли-ризики:**
  - `packages/motion-kit/src/index.ts` → лише B2.
  - `packages/shared/test/prompts.test.ts` → Крок 0, потім лише B6 (B5 не змінює набір змінних codegen).
  - `pnpm-lock.yaml` / `package.json` → нових залежностей не додаємо: іконки — дані в коді, обробка звуку — без бібліотек.
    Якщо блоку все ж потрібна залежність — зупинитись і винести в окремий крок.
  - `packages/director/src/index.ts` → не змінювати; якщо потрібен новий експорт, додає власник модуля
    після злиття своєї хвилі.

## 5. Спільні ресурси й ізоляція

- **LLM, ElevenLabs:** блоки працюють лише з mock-клієнтами в тестах. Живі виклики (платні) — тільки
  в етапі L, запускає власник.
- **`DATA_DIR`:** у кожному worktree свій `./.data` (`.env.example: DATA_DIR=./.data`). Чужі `.data` не чіпати.
- **Redis/BullMQ, порти API:** блоки сервіси не піднімають. Інтеграційні тести — лише у фінальному прогоні,
  в одному worktree.
- **Chromium:** потрібен тестам `crawler` (B1) і `render` (фінал). Свіжий worktree може потребувати
  `pnpm install` і встановлення браузера Playwright.
- **Нагадування:** worktree ізолює файли, але не БД, env, порти й запущені сервіси.

## 6. План інтеграції

- **Порядок злиття:** Крок 0 → хвиля 1: B2 → B4 → B1 → B3 → хвиля 2: B5 → B6.
- **Інтеграційна гілка:** `claude/video-quality-integration` від `main` після Кроку 0. Блоки гілкуються від неї
  і зливаються в неї. Після кожного злиття решта гілок хвилі оновлюються від інтеграційної, щоб конфлікти
  спливали рано й малими порціями.
- **Після хвилі 1:**
  `pnpm --filter @adc/motion-kit test && pnpm --filter @adc/crawler test && pnpm --filter @adc/brandkit test
  && pnpm --filter @adc/audio test && pnpm --filter @adc/pipeline test && pnpm vitest run --project director
  packages/director/test/storyboard packages/director/test/normalize packages/director/test/claims
  packages/director/test/typecheck.test.ts` + smoke.
- **Після хвилі 2:**
  `pnpm --filter @adc/director test && pnpm --filter @adc/pipeline test && pnpm vitest run --project shared
  packages/shared/test/prompts.test.ts` + smoke.
- **Smoke:** `pnpm typecheck && pnpm --filter @adc/shared test`.
- **Фінал:** повний прогін (§7), потім злиття інтеграційної гілки в `main`.
- **Етап L (не код, платно, запускає власник):** живий прогін на webreportio.com, 9:16, з відповіддю
  «показати сервіс і його функції», плюс 1–2 сайти іншого типу. Зберегти `costs.jsonl`/`trace.jsonl`.
  Приймання — оцінка власника: у кадрі реальні функції продукту, немає кадрів, що стоять > 1.5 с, кожна
  поява звучить, склейки на долях, ролик не гірший за еталон.

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | Лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | Тести Кроку 0 + smoke | Ні |
| Після злиття хвилі 1 / хвилі 2 | Об'єднана команда хвилі з §6 + smoke | Ні |
| Блок змінив спільний файл | Тести блоку + тести модулів, що імпортують файл: `shared/src/timeline.ts` → audio, director, pipeline, remotion typecheck; `shared/src/schemas/storyboard.ts` → director, pipeline, audio, api; `guard.ts` → director, motion-kit (`examples.test.ts`) | Ні |
| **Фінал — усе злито** | **`pnpm test && pnpm typecheck && pnpm lint`** | **Так, один раз** |

Правила для агента (дослівно):
- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку/хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на main до змін;
  якщо падало — не чіпай, лише зафіксуй у звіті.»
- «Фінальний прогін — це ворота перед деплоєм: поки він не зелений, ТЗ не вважається виконаним.»

## 8. Review і Definition of Done

**На блок:**
- тести блоку зелені;
- `pnpm exec biome check <змінені файли>` чистий;
- немає правок поза файлами з карти власності;
- diff проти інтеграційної гілки маленький і зрозумілий;
- у промптах блоку немає жодного правила з таблиці §2.10 «прибираємо».

**На ТЗ:**
- фінальний `pnpm test && pnpm typecheck && pnpm lint` зелений (або падіння підтверджено як наявні на `main` до змін);
- етап L проведено, власник прийняв результат.

## 9. Поза скоупом (свідомо)

- Eval-стенд, A/B, судді-моделі.
- Зміна моделі на Fable 5.1 (рішення власника — Opus 5.5 `high`; перемикач — frontmatter промптів).
- Повний синтез музики кодом (рішення власника — ElevenLabs-підкладка).
- Веб-UI чекпоінтів (`apps/api/public/static/js/views/cp-*.js` — заглушки).
- Генерація зображень і відео, 3D, стоки.

## 10. Запуск у Claude Code

- **Крок 0** — одна сесія Desktop. Після злиття створити інтеграційну гілку.
- **Хвиля 1** — 4 окремі сесії Desktop (B1, B2, B3, B4), кожна в своєму worktree від інтеграційної гілки.
  CLI-еквівалент: `claude -w vq-b1`, `claude -w vq-b2`, `claude -w vq-b3`, `claude -w vq-b4`.
- **Хвиля 2** — 2 сесії (B5, B6).
- **Нагадування:** `main` чистий, усе гілкується від інтеграційної гілки; не більше 4 потоків одночасно;
  свіжий worktree — `pnpm install`; після злиття — `git worktree remove`.
