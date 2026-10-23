# ТЗ: темна тема AdCreative і перемикач теми

## 1. Мета і контекст

Додаємо до веб-клієнта `apps/api/public` другу тему — темну, напрям **1a «Графіт»** (затверджено). Додаємо також перемикач «Світла · Темна · Як у системі». Змінюються лише кольори й трекінг дисплейних кеглів. Розкладка, розміри, відступи, тексти, шрифти, радіуси й іконки не змінюються. Світла тема має лишитися незмінною до пікселя.

Візуальний еталон — `docs/design/AdCreative Dark Reference.dc.html` (секції T, T·P, C/K, SW1–SW4, D, S). Коли ТЗ і еталон розходяться, правий еталон за кольором, а ТЗ — за кодом і поведінкою.

Механізм теми — атрибут `data-theme="light|dark"` на `<html>`, тобто блок `:root[data-theme="dark"]` у `tokens.css`. Перемикання не перемонтовує в’юхи й не чіпає store і SSE.

Головна проблема — `--ink` має 7 ролей: текст, заливка, рамка, пройдено, `::selection`, фокус, підкладка відео. Вона розщеплюється на семантичні токени. У світлій темі кожен новий токен дорівнює старому значенню, тому міграція — це лише заміна імені змінної в селекторах із Додатка A.

Документ: розділи 1–9 у форматі parallel-ready, далі додатки A–F (таблиця міграції, перемикач, пограничні випадки, скоуп, приймання, контраст).

---

## 2. Крок 0 — заморожені інтерфейси (окремий PR, першим)

Поки Крок 0 не влитий в інтеграційну гілку, паралельна робота не стартує. Крок 0 володіє `tokens.css`, `base.css`, `components.css`, `index.html`, `app.js` — це вже прописано в шапках цих файлів.

### 0.1 `apps/api/public/static/css/tokens.css`

Колірну частину `:root` замінити на код нижче. Секції T2 (шрифти), T3 (радіуси, розміри) і T4 (рух) лишаються без змін. Значення існуючих токенів у `:root` не змінюються. Нові токени у світлій темі дорівнюють значенням, які вони заміщують (див. коментарі).

```css
:root {
  color-scheme: light;

  /* T1 · Поверхні */
  --paper: #f5f3ee; /* фон сторінки, старт, топбар, таймлайн */
  --chat: #f1efe9; /* панель діалогу */
  --stage: #f8f7f3; /* права панель (сцена) */
  --card: #fcfbf8; /* картки, композер, панель рішень */
  --track-2: #e7e3da; /* сцени на треку сценарію */
  --track-3: #d4cec2;

  /* T1 · Текст і акценти */
  --ink: #151412; /* ЛИШЕ текст і гліфи. Заливки/рамки/прогрес — токени нижче */
  --ink-2: #3a3833; /* вторинний текст, лід-абзаци */
  --muted: #6e6a63; /* підписи, eyebrow, мета (4.85:1 на --paper, 4.68:1 на --chat) */
  --accent: #d4402a; /* REC: плейхед, ромб очікування, busy-точка, hover primary */
  --danger: #b8331f; /* текст помилки */
  --ok: #2f8f5b; /* «на зв'язку» */
  --on-accent: #ffffff; /* текст на --accent (≥ 10.5px / 600) */

  /* Темна тема · ролі колишнього --ink. У світлій = #151412 / #f5f3ee, як було. */
  --fill-strong: #151412; /* інверсна заливка: primary, бульбашка, обраний chip/seg/тайл, round, ::selection */
  --on-fill-strong: #f5f3ee; /* текст/гліф на --fill-strong і на hover-акценті */
  --on-ink: var(--on-fill-strong); /* АЛІАС на час міграції — видаляється в Кроці 2 */
  --edge-strong: #151412; /* активна/hover-рамка, рамка меню, лінія полів, підсумкові лінії */
  --focus-ring: #151412; /* outline :focus-visible */
  --progress: #151412; /* пройдено/готово: тіки, ромб done, смуги, скраббер, хвиля, крапка */

  /* T1 · Лінії */
  --line: rgba(21, 20, 18, 0.1); /* розділювачі, рамки панелей */
  --line-strong: rgba(21, 20, 18, 0.16); /* рамки ghost-кнопок, чипів, полів */
  --line-soft: rgba(21, 20, 18, 0.12); /* рамки карток у чаті, трек .bar */
  --line-tile: rgba(21, 20, 18, 0.14); /* ← --cb-tile-line (cp-brand.css:4) */
  --line-dashed: rgba(21, 20, 18, 0.25); /* ← --cb-add-line (cp-brand.css:5), checkout.css:66 */
  --tick: rgba(21, 20, 18, 0.2); /* непройдені тіки таймлайну */
  --diamond-idle: rgba(21, 20, 18, 0.45); /* рамка майбутнього ромба */
  --diamond-stale: rgba(21, 20, 18, 0.4); /* ← components.css:356 (.diamond--stale) */
  --disabled-fill: rgba(21, 20, 18, 0.28); /* «надіслати» без тексту */
  --spinner-track: rgba(21, 20, 18, 0.15);
  --danger-line: rgba(184, 51, 31, 0.35); /* рамка картки помилки */
  --accent-ring: rgba(212, 64, 42, 0.5);
  --accent-ring-0: rgba(212, 64, 42, 0);
  --accent-mark: rgba(212, 64, 42, 0.28); /* підсвітка непідтвердженого твердження */

  /* Медіа (дані клієнта не перефарбовуються — змінюється підкладка й кільце) */
  --media-bg: #151412; /* підкладка кадру .dn-frame, бейдж ✓ на плиті лого */
  --on-media: #f5f3ee; /* гліф на --media-bg */
  --media-ring: rgba(21, 20, 18, 0.12); /* кільце стілів, аркушів, свотчів (= --line-soft) */
  --logo-plate: #fcfbf8; /* плита під лого бренду (= --card) */
  --placeholder-a: #e9e5dc; /* смугастий плейсхолдер медіа */
  --placeholder-b: #f1eee7;

  /* Акаунти (Крок 0) */
  --scrim: rgba(21, 20, 18, 0.32); /* підкладка модалки входу */
  --veil: rgba(245, 243, 238, 0.78); /* резерв для оверлеїв */
  --danger-field: rgba(184, 51, 31, 0.55); /* рамка поля-картки з помилкою */

  /* T1 · Тінь — лише плеєр */
  --shadow-player: 0 30px 60px -30px rgba(21, 20, 18, 0.45), 0 0 0 1px rgba(21, 20, 18, 0.06);

  /* Типографіка · поправка трекінгу дисплейних кеглів (у світлій 0) */
  --trk-display: 0em;

  /* T2, T3, T4 — без змін */
}
```

Одразу після `:root` додати темний блок. Значення затверджені, міняти їх не можна:

```css
:root[data-theme="dark"] {
  color-scheme: dark;

  /* Поверхні · L oklch: чат 0.201 < сторінка 0.219 < сцена 0.236 < картка 0.262; тон h 75, хрома ≤ 0.009 */
  --paper: #1c1a18;
  --chat: #181613;
  --stage: #201e1b;
  --card: #272421;
  --track-2: #34312e;
  --track-3: #484440;

  /* Текст */
  --ink: #ebe7e2;
  --ink-2: #c4c0bb;
  --muted: #9a9691;

  /* Ролі колишнього --ink */
  --fill-strong: #e1ddd8;
  --on-fill-strong: #1c1a18;
  --edge-strong: #b4b0ac;
  --focus-ring: #ebe7e2;
  --progress: #e1ddd8;

  /* Акцент і стани · тон той самий, світліший для темного тла */
  --accent: #ef5e41;
  --on-accent: #1c1a18;
  --danger: #ed756e;
  --ok: #4ab074;
  --accent-ring: rgba(239, 94, 65, 0.45);
  --accent-ring-0: rgba(239, 94, 65, 0);
  --accent-mark: rgba(239, 94, 65, 0.32);
  --danger-line: rgba(237, 117, 110, 0.4);
  --danger-field: rgba(237, 117, 110, 0.6);

  /* Лінії · альфа від --ink темної теми */
  --line: rgba(235, 231, 226, 0.1);
  --line-strong: rgba(235, 231, 226, 0.16);
  --line-soft: rgba(235, 231, 226, 0.12);
  --line-tile: rgba(235, 231, 226, 0.14);
  --line-dashed: rgba(235, 231, 226, 0.26);
  --tick: rgba(235, 231, 226, 0.22);
  --diamond-idle: rgba(235, 231, 226, 0.45);
  --diamond-stale: rgba(235, 231, 226, 0.38);
  --disabled-fill: rgba(235, 231, 226, 0.2);
  --spinner-track: rgba(235, 231, 226, 0.16);

  /* Медіа · дані не перефарбовуються */
  --media-bg: #0b0a08;
  --on-media: #ebe7e2;
  --media-ring: rgba(235, 231, 226, 0.14);
  --logo-plate: #d4d0cb;
  --placeholder-a: #292724;
  --placeholder-b: #23211e;

  /* Оверлеї і тінь */
  --scrim: rgba(11, 10, 8, 0.62);
  --veil: rgba(28, 26, 24, 0.78);
  --shadow-player: 0 30px 60px -30px rgba(11, 10, 8, 0.72), 0 0 0 1px rgba(235, 231, 226, 0.1);

  /* Типографіка */
  --trk-display: 0.006em;
}
```

### 0.2 `apps/api/public/static/css/base.css`

```css
/* було: background: var(--ink); color: var(--on-ink); */
::selection {
  background: var(--fill-strong);
  color: var(--on-fill-strong);
}

/* було: outline: 2px solid var(--ink); */
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* Тема: на час перемикання transition вимкнено, інакше сотні елементів із transition .2s
   перефарбовуються несинхронно. Поля виключено, щоб не зламати автозаповнення нижче. */
:root[data-theme-switching] *:not(input):not(textarea),
:root[data-theme-switching] *::before,
:root[data-theme-switching] *::after {
  transition: none !important;
}

/* Кросфейд зміни теми (View Transitions). Reduced-motion — без VT, див. theme.js. */
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: var(--t-hover);
  animation-timing-function: var(--ease);
}

/* Автозаповнення в темній: прибрати світло-жовту/блакитну підкладку UA, лишити тло поля.
   Лише темна — світла тема не змінюється. */
:root[data-theme="dark"] input:-webkit-autofill,
:root[data-theme="dark"] input:-webkit-autofill:hover,
:root[data-theme="dark"] input:-webkit-autofill:focus,
:root[data-theme="dark"] textarea:-webkit-autofill {
  -webkit-text-fill-color: var(--ink);
  transition: background-color 600000s 0s, color 600000s 0s;
}
```

Інших змін у `base.css` немає. Тло `body` (`var(--paper)`) переходить на canvas — смуги під час overscroll отримують колір теми самі. Keyframes `adc-ring` уже беруть `--accent-ring*`, а `adc-pulse`, `ac-delta`, `adc-spin`, `adc-fade`, `sp-indeterminate` кольору не мають — їх не чіпаємо.

### 0.3 `apps/api/public/static/css/components.css`

Міграція — рядки розділу «Крок 0» з Додатка A (+ типографіка `.display-*` / `.numeral`).

### 0.4 `apps/api/public/index.html`

Одразу після `<meta name="viewport" …>`, до `<title>` і стилів, вставити:

```html
<meta name="theme-color" content="#f5f3ee">
<script src="/static/js/theme-boot.js"></script>
```

Після `<link rel="stylesheet" href="/static/css/account.css">` додати `<link rel="stylesheet" href="/static/css/theme-switch.css">`.

Скрипт класичний, синхронний: без `type="module"`, `defer` і `async`. Тільки так атрибут стоїть до першого кадру.

### 0.5 `apps/api/public/static/js/theme-boot.js` (новий, повний код)

```js
/*
 * Тема до першого кадру (без спалаху). Класичний синхронний скрипт у <head> до стилів.
 * Без inline-скриптів, eval, innerHTML. Логіку резолву дублює lib/theme.js — паритет перевіряє test/ui/theme.test.ts.
 */
(function () {
  var root = document.documentElement;
  var pref = "system";
  var locked = false;
  try {
    var q = new URLSearchParams(location.search);
    var t = q.get("theme");
    if (q.has("fixture") && (t === "light" || t === "dark")) {
      pref = t;
      locked = true;
    } else {
      var s = localStorage.getItem("adc.theme");
      if (s === "light" || s === "dark" || s === "system") pref = s;
    }
  } catch (e) {}
  var dark =
    pref === "dark" ||
    (pref === "system" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-pref", pref);
  if (locked) root.setAttribute("data-theme-locked", "");
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#1c1a18" : "#f5f3ee");
})();
```

### 0.6 `apps/api/public/static/js/lib/theme.js` (новий; API заморожено)

```js
export const THEME_KEY = "adc.theme";
/** @typedef {"light" | "dark" | "system"} ThemePref */
/** @typedef {"light" | "dark"} Theme */
/** @typedef {{ pref: ThemePref, theme: Theme, locked: boolean, systemDark: boolean }} ThemeState */
export const THEME_COLOR = { light: "#f5f3ee", dark: "#1c1a18" };

/** @param {unknown} v @returns {ThemePref} невідоме → "system" */
export function parsePref(v) {}
/** @param {ThemePref} pref @param {boolean} systemDark @returns {Theme} */
export function resolveTheme(pref, systemDark) {}
/** Поточний стан. Початкові значення — з атрибутів, які поставив theme-boot.js. @returns {ThemeState} */
export function getTheme() {}
/** Вибір користувача: зберегти (якщо не locked) → застосувати з анімацією → сповістити. @param {ThemePref} pref */
export function setThemePref(pref) {}
/** @param {(s: ThemeState) => void} fn @returns {() => void} відписка */
export function subscribeTheme(fn) {}
/** Один раз з app.js: слухачі storage і matchMedia. Ідемпотентна. */
export function initTheme() {}
```

Поведінка (контракт для B5 і тестів):

- `localStorage` загорнуто в `try/catch`. Якщо сховище недоступне, стан живе в пам’яті модуля.
- `setThemePref(p)`:
  - якщо стан не `locked`, записує `localStorage.setItem(THEME_KEY, p)`;
  - рахує `theme = resolveTheme(p, systemDark)`;
  - застосовує тему з анімацією;
  - сповіщає підписників.

  Значення `"system"` теж записується явно — так другі вкладки отримують подію `storage`.
- Застосування:
  1. `root.setAttribute("data-theme-switching", "")`.
  2. Функція `swap` виставляє `data-theme`, `data-theme-pref` і `meta[name=theme-color].content = THEME_COLOR[theme]`.
  3. Якщо треба анімувати, `prefers-reduced-motion` не `reduce` і `document.startViewTransition` існує — `startViewTransition(swap).finished.finally(clear)`. Інакше — `swap()`, потім `requestAnimationFrame(() => requestAnimationFrame(clear))`, де `clear` знімає `data-theme-switching`.
  4. Анімує лише `setThemePref`. Зміни зі `storage` і `matchMedia` застосовуються миттєво.
- `initTheme()`:
  - `window.addEventListener("storage", e => e.key === THEME_KEY && !locked && apply(parsePref(e.newValue)))`;
  - `matchMedia("(prefers-color-scheme: dark)").addEventListener("change", …)` — тема перераховується лише при `pref === "system"`.
- Заборонено: перезавантажувати сторінку, змінювати store, торкатися SSE чи DOM поза `<html>` і `meta[name=theme-color]`.

### 0.7 `apps/api/public/static/js/app.js`

Імпорт `import { initTheme } from "./lib/theme.js";` і виклик `initTheme()` на початку `boot`/ініціалізації — до монтування в’юх. Більше нічого.

### 0.8 Заглушки для блоків

- `apps/api/public/static/css/theme-switch.css` з однією шапкою `/* .tm- · B5 · перемикач теми (SW). */`. Наповнює B5.
- Тестові медіа в `apps/api/public/static/dev/media/`: `logo-dark-transparent.svg`, `logo-light-transparent.svg`, `logo-neon-transparent.svg` (з еталона, `media/`). Це «найгірші бренди» для приймання (Додаток E).

### 0.9 Еталон

Скопіювати в `docs/design/`:

- `AdCreative Dark Reference.dc.html`, `DkKit.dc.html`, `DkStart.dc.html`, `DkWorkspace.dc.html`, `DkTheme.dc.html`;
- `media/` еталона в `docs/design/media/`.

### 0.10 Тести Кроку 0

1. `apps/api/test/ui/theme.test.ts` (happy-dom):
   - `parsePref`: невідоме → `system`;
   - `resolveTheme`: 6 комбінацій;
   - `setThemePref` пише `adc.theme` і ставить `data-theme`/`data-theme-pref`/`theme-color`;
   - у locked-стані нічого не пише;
   - подія `storage` застосовує тему;
   - `matchMedia change` діє лише при `system`;
   - `data-theme-switching` знято після кадру.

   Паритет із boot: виконати `theme-boot.js` через `node:vm` `runInNewContext(src, { document, localStorage, location, matchMedia, URLSearchParams })` на матриці (`localStorage` × `?fixture&theme` × система) і порівняти з `resolveTheme`.
2. `apps/api/test/ui/theme-tokens.test.ts` — guard без нових залежностей; CSS парситься регекспом за декларацією. Тест-кейс на кожен файл з `static/css`: `it.each(CSS_FILES)("%s", …)`. Правила:
   - **R1.** Поза `tokens.css` немає `#hex`, `rgb(a)(`, `hsl(a)(`. `transparent`, `currentColor` і `color-mix(… var(--…) …)` дозволені.
   - **R2.** `var(--ink)` дозволено лише у властивостях `color`, `caret-color`, `text-decoration-color`, `fill`, `stroke`, `-webkit-text-fill-color` і в селекторах, що містять `__glyph` (гліфи `.cb-fmt__glyph`, `.cab-proj__glyph`).
   - **R3.** Немає `--on-ink`, `--cb-tile-line`, `--cb-add-line`.
   - **R4.** Кожне правило, де `font` містить `var(--f-display)` і розмір ≥ 28px або `clamp(` з мінімумом ≥ 28px, має `letter-spacing: calc(<старе> + var(--trk-display))`.
   - **R5** (лише `tokens.css`):
     - кожен колірний токен `:root` (усе, крім `--f-*`, `--r-*`, `--topbar-h`, `--chat-col`, `--btn-h*`, `--ease`, `--t-*`, `--ac-delta`) є в `:root[data-theme="dark"]`, крім аліасу `--on-ink`;
     - світлі значення нових токенів дорівнюють заміщуваним: `--fill-strong` = `--edge-strong` = `--focus-ring` = `--progress` = `--media-bg` = `#151412`, `--on-fill-strong` = `--on-media` = `#f5f3ee`, `--media-ring` = `rgba(21, 20, 18, 0.12)`, `--logo-plate` = `#fcfbf8`, `--line-tile` = `rgba(21, 20, 18, 0.14)`, `--line-dashed` = `rgba(21, 20, 18, 0.25)`, `--diamond-stale` = `rgba(21, 20, 18, 0.4)`, `--trk-display` = `0em`;
     - у темному блоці немає `#000`, `#000000`, `#fff`, `#ffffff`.

   Файли, які ще не мігрували, червоні — це очікувано. Кожен блок запускає лише свої кейси через `-t` (розділ 7).

Команда Кроку 0:
`pnpm --filter @adc/api exec vitest run test/ui/theme.test.ts test/static.test.ts test/ui/integration.test.ts && pnpm --filter @adc/api exec vitest run test/ui/theme-tokens.test.ts -t "tokens.css|base.css|components.css"`

---

## 3. Блоки робіт

У кожному CSS-блоці дозволені лише зміни з Додатка A для своїх файлів. Будь-який інший рядок у `git diff --word-diff` — відхилення, PR повертається.

### B1: Воркспейс — хром і діалог
- **Володіє:** `static/css/chrome.css`, `static/css/chat.css`, `static/css/stage-progress.css`.
- **Залежить від:** Кроку 0 (токени, guard-тест).
- **Що зробити:** рядки B1 з Додатка A (7 змін).
- **Критерії приймання:** R1–R4 зелені для трьох файлів. У темній `awaitingStoryboard`, `delivered`, `ws-long` збігаються з кадрами S4/S5 еталона: таймлайн, бульбашка, картки ЧП, композер, «на зв’язку». У світлій різниці немає.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/theme-tokens.test.ts -t "chrome.css|chat.css|stage-progress.css"` + `pnpm exec biome check apps/api/public/static/css/chrome.css apps/api/public/static/css/chat.css apps/api/public/static/css/stage-progress.css`.
- **Паралельність:** хвиля 1, разом із B2 і B5.

### B2: Сцена — чекпоінти й «Готово»
- **Володіє:** `static/css/cp-brand.css`, `static/css/cp-script.css`, `static/css/cp-board.css`, `static/css/done.css`.
- **Залежить від:** Кроку 0.
- **Що зробити:** рядки B2 з Додатка A (26 змін). Видалити локальні `--cb-tile-line` і `--cb-add-line` з `.cb` (cp-brand.css:4–5).
- **Критерії приймання:** R1–R4 зелені. Плита лого, бейдж ✓, кільце стілів, аркушів і свотчів, підкладка кадру й тінь плеєра — як у секції D еталона. Ціна в «Затвердити й рендерити» читається в обох темах.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/theme-tokens.test.ts -t "cp-brand.css|cp-script.css|cp-board.css|done.css"` + `pnpm exec biome check apps/api/public/static/css/cp-brand.css apps/api/public/static/css/cp-script.css apps/api/public/static/css/cp-board.css apps/api/public/static/css/done.css`.
- **Паралельність:** хвиля 1.

### B3: Старт, вхід, сесія, нестача
- **Володіє:** `static/css/start.css`, `static/css/auth.css`, `static/css/session.css`, `static/css/shortage.css`.
- **Залежить від:** Кроку 0.
- **Що зробити:** рядки B3 з Додатка A (12 змін), включно з типографікою `auth.css` і `session.css`.
- **Критерії приймання:** R1–R4 зелені. `n3-guest`, `n3-user`, `n3-402`, `n1-*`, `n2-*`, `n15-logout` у темній: лінія URL — `--edge-strong`, спінер на primary видно, модалка лежить на `--scrim`.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/theme-tokens.test.ts -t "start.css|auth.css|session.css|shortage.css"` + `pnpm exec biome check apps/api/public/static/css/start.css apps/api/public/static/css/auth.css apps/api/public/static/css/session.css apps/api/public/static/css/shortage.css`.
- **Паралельність:** хвиля 2, разом із B4.

### B4: Акаунти — пілюля, кабінет, checkout, адмінка
- **Володіє:** `static/css/account.css`, `static/css/cabinet.css`, `static/css/cab-balance.css`, `static/css/cab-history.css`, `static/css/cab-projects.css`, `static/css/cab-profile.css`, `static/css/checkout.css`, `static/css/admin.css`.
- **Залежить від:** Кроку 0.
- **Що зробити:** рядки B4 з Додатка A (44 змін), включно з типографікою `admin.css`, `cab-balance.css`, `checkout.css`.
- **Критерії приймання:** R1–R4 зелені. `n4-menu`, `n4-admin`, кабінет (усі розділи), checkout, адмінка в темній без жодного «світлого кирпича». Коло акаунта у відкритому стані — `--fill-strong` з рамкою `--fill-strong`.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/theme-tokens.test.ts -t "account.css|cabinet.css|cab-balance.css|cab-history.css|cab-projects.css|cab-profile.css|checkout.css|admin.css"` + `pnpm exec biome check apps/api/public/static/css/account.css apps/api/public/static/css/cabinet.css apps/api/public/static/css/cab-*.css apps/api/public/static/css/checkout.css apps/api/public/static/css/admin.css`.
- **Паралельність:** хвиля 2.

### B5: Перемикач теми
- **Володіє:**
  - `static/js/views/theme-switch.js` (новий), `static/css/theme-switch.css` (заглушка з Кроку 0);
  - `static/js/views/account-controls.js`, `static/js/views/start.js` — лише вставка перемикача;
  - `static/dev/fixtures/start.js` — нова фікстура `n3-guest-theme`;
  - `test/ui/theme-switch.test.ts` (новий), `test/ui/account-controls.test.ts`, `test/ui/start.test.ts`.
- **Залежить від:** Кроку 0 (`lib/theme.js`). На CSS блоків B1–B4 не спирається: свої класи `.tm-*` пише на нових токенах.
- **Що зробити:** Додаток B повністю.
- **Критерії приймання:**
  - SW2/SW3 еталона відтворені: стани, обидві теми, 1440 і 390;
  - клавіатурний прохід за Додатком B;
  - гість на старті бачить коло перед «Увійти», користувач — групу «Тема» в меню акаунта в усіх п’яти оболонках;
  - вибір зберігається, синхронізується між вкладками, не перезавантажує сторінку;
  - `n4-menu` і `n3-guest-theme` відкриваються з меню.
- **Тести:** `pnpm --filter @adc/api exec vitest run test/ui/theme-switch.test.ts test/ui/account-controls.test.ts test/ui/start.test.ts test/ui/topbar.test.ts test/ui/checkout.test.ts test/ui/cabinet.test.ts test/ui/admin.test.ts` + `pnpm exec biome check apps/api/public/static/js/views/theme-switch.js apps/api/public/static/js/views/account-controls.js apps/api/public/static/js/views/start.js apps/api/public/static/css/theme-switch.css`.
- **Паралельність:** хвиля 1.

### Крок 2: Прибирання і приймання (послідовно, після хвилі 2)
- **Володіє:** `static/css/tokens.css` (видалити аліас `--on-ink`) і `test/ui/theme-tokens.test.ts` (R3 стає глобальним).
- **Що зробити:**
  1. Видалити `--on-ink`.
  2. Перевірити `grep -R "on-ink\|cb-tile-line\|cb-add-line" apps/api/public/static` — порожньо.
  3. Пройти Додаток E.
- **Тести:** фінальний прогін (розділ 7).

---

## 4. Карта володіння файлами

| Власник | Файли |
|---|---|
| Крок 0 | `static/css/tokens.css`, `static/css/base.css`, `static/css/components.css`, `index.html`, `static/js/app.js`, `static/js/theme-boot.js` (новий), `static/js/lib/theme.js` (новий), заглушка `static/css/theme-switch.css`, `static/dev/media/logo-*-transparent.svg` (нові), `test/ui/theme.test.ts`, `test/ui/theme-tokens.test.ts`, `docs/design/*` (еталон) |
| B1 | `chrome.css`, `chat.css`, `stage-progress.css` |
| B2 | `cp-brand.css`, `cp-script.css`, `cp-board.css`, `done.css` |
| B3 | `start.css`, `auth.css`, `session.css`, `shortage.css` |
| B4 | `account.css`, `cabinet.css`, `cab-balance.css`, `cab-history.css`, `cab-projects.css`, `cab-profile.css`, `checkout.css`, `admin.css` |
| B5 | `theme-switch.js` (новий), `theme-switch.css`, `account-controls.js`, `start.js`, `dev/fixtures/start.js`, `test/ui/theme-switch.test.ts`, `test/ui/account-controls.test.ts`, `test/ui/start.test.ts` |
| Крок 2 | `tokens.css` (рядок `--on-ink`), `test/ui/theme-tokens.test.ts` |

Спільні файли мають одного власника:

- `index.html`, `app.js` — Крок 0. Тег `<link>` для `theme-switch.css` ставить Крок 0, тому B5 не чіпає `index.html`.
- `start.css` — у B3, `start.js` — у B5: B5 не потребує правил у `start.css`, бо `.st-account` уже flex з `gap: 20px`.
- `account.css` — у B4, `account-controls.js` — у B5: стилі групи «Тема» в меню (`.ac-menu .tm-*`) живуть у `theme-switch.css`.

---

## 5. Спільні ресурси й ізоляція

- **БД/Redis:** UI-тести (`test/ui/*`) працюють на happy-dom без Redis. Блоки серверний код не чіпають — ізоляція БД не потрібна.
- **Порти:** для візуальної звірки кожен worktree піднімає dev-сервер на своєму порту: `PORT=3101 pnpm --filter @adc/api dev` (B1), `3102` (B2), `3103` (B3), `3104` (B4), `3105` (B5). `PORT` читає `src/server.ts`.
- **localStorage:** `adc.theme` живе в межах origin. Різні порти — різні origin, тож worktree один одному вибір не перезаписують. Для фікстур користуйтеся `&theme=dark` — він не пише в сховище.
- worktree не ізолює env і порти — їх розводимо вручну, як вище.

---

## 6. План інтеграції

- Інтеграційна гілка — `feat/dark-theme` від `main`. Усі блоки зливаються в неї. У `main` вона потрапляє один раз — після Кроку 2. Так користувачі з темною ОС не побачать напівмігровану темну тему.
- Порядок: **Крок 0 → хвиля 1 (B1, B2, B5) → хвиля 2 (B3, B4) → Крок 2 → `main`**. Стеля — три паралельні потоки.
- Після кожного злиття решта гілок підтягує `feat/dark-theme` (`git merge feat/dark-theme`), щоб конфлікти спливали рано. Перетину файлів немає, тож конфлікти очікуються лише в разі порушення карти власності.
- Після хвилі 1: `pnpm --filter @adc/api exec vitest run test/ui/theme-tokens.test.ts -t "tokens.css|base.css|components.css|chrome.css|chat.css|stage-progress.css|cp-brand.css|cp-script.css|cp-board.css|done.css" && pnpm --filter @adc/api exec vitest run test/ui/theme.test.ts test/ui/theme-switch.test.ts test/ui/account-controls.test.ts test/ui/start.test.ts test/ui/integration.test.ts`.
- Після хвилі 2: `pnpm --filter @adc/api exec vitest run test/ui/theme-tokens.test.ts -t "start.css|auth.css|session.css|shortage.css|account.css|cabinet.css|cab-balance.css|cab-history.css|cab-projects.css|cab-profile.css|checkout.css|admin.css" && pnpm --filter @adc/api exec vitest run test/ui/integration.test.ts`.

---

## 7. Правила тестування

| Момент | Що запускати | Повний прогін? |
|---|---|---|
| Під час роботи над блоком | Лише команда з поля «Тести» блоку | Ні |
| Після Кроку 0 | Команда Кроку 0 (п. 0.10) | Ні |
| Після злиття хвилі | Команда хвилі з розділу 6 (smoke — `test/ui/integration.test.ts`) | Ні |
| Блок змінив спільний файл (`app.js`, `account-controls.js`, `start.js`) | Тести блоку + споживачі: `topbar.test.ts`, `checkout.test.ts`, `cabinet.test.ts`, `admin.test.ts`, `integration.test.ts` (уже в командах Кроку 0 і B5) | Ні |
| **Фінал — Крок 2 завершено** | **`pnpm test && pnpm typecheck && pnpm lint`** | **Так, один раз** |

Правила для агента (дослівно):

- «Не запускай повний `pnpm test` до фінального кроку. Використовуй лише команди, вказані для блоку чи хвилі.»
- «Якщо фінальний повний прогін падає в модулі поза скоупом ТЗ — спершу перевір, чи падало це на main до змін; якщо падало — не чіпай, лише зафіксуй у звіті.»
- «Фінальний прогін — це ворота перед злиттям у main: поки він не зелений, ТЗ не вважається виконаним.»

---

## 8. Definition of Done

**На блок:**
- тести блоку зелені, `biome check` чистий на змінених файлах;
- немає правок поза власними файлами;
- diff CSS містить лише рядки з Додатка A для своїх файлів;
- візуальна звірка 3–5 фікстур блоку в обох темах проти еталона.

**На ТЗ:**
- фінальний `pnpm test && pnpm typecheck && pnpm lint` зелений (або падіння підтверджено як наявні на main до змін);
- Додаток E пройдено повністю;
- `--on-ink` видалено.

---

## 9. Запуск у Claude Code

- **Просто (рекомендовано):** окрема сесія Desktop на кожен блок хвилі — кожна отримує свій worktree.
- **CLI:** `claude -w dark-step0`; після злиття — `claude -w dark-b1`, `claude -w dark-b2`, `claude -w dark-b5`; потім `claude -w dark-b3`, `claude -w dark-b4`; наприкінці `claude -w dark-step2`.
- **Субагенти:** `isolation: worktree` у frontmatter `.claude/agents/*.md` або «use worktrees for your agents».
- Тримати `main` чистим. Свіжому worktree потрібен `pnpm install`. Після злиття — `git worktree remove`.

---

## Додаток A. Таблиця міграції

Рядки — станом на коміт аудиту. Якщо рядок зсунувся, орієнтир — селектор і властивість. Колонка «Стає» — повне нове значення декларації.

Не змінюються:

- `var(--ink)` у ролі тексту (71 місць: `color` і `text-decoration-color`);
- гліфи `.cb-fmt__glyph`, `.cb-fmt.is-on .cb-fmt__glyph`, `.cab-proj__glyph` — це малюнок, а не заливка; у темній вони світлі, як текст.

### Крок 0 · 28 змін

| Файл:рядок | Селектор | Властивість | Було | Стає |
|---|---|---|---|---|
| `base.css:78` | `::selection` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `base.css:79` | `::selection` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `base.css:88` | `:focus-visible` | `outline` | `2px solid var(--ink)` | `2px solid var(--focus-ring)` |
| `components.css:32` | `.btn--primary` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `components.css:33` | `.btn--primary` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `components.css:38` | `.btn--primary:hover:not(:disabled)` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `components.css:46` | `.btn--ghost:hover:not(:disabled)` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `components.css:52` | `.btn--ghost-ink` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `components.css:84` | `.btn--tag:hover:not(:disabled)` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `components.css:105` | `.btn-round` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `components.css:106` | `.btn-round` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `components.css:199` | `.display-xl` | `letter-spacing` | `-0.05em` | `calc(-0.05em + var(--trk-display))` |
| `components.css:204` | `.display-l` | `letter-spacing` | `-0.05em` | `calc(-0.05em + var(--trk-display))` |
| `components.css:209` | `.display-brand` | `letter-spacing` | `-0.055em` | `calc(-0.055em + var(--trk-display))` |
| `components.css:214` | `.display-m` | `letter-spacing` | `-0.045em` | `calc(-0.045em + var(--trk-display))` |
| `components.css:219` | `.display-s` | `letter-spacing` | `-0.04em` | `calc(-0.04em + var(--trk-display))` |
| `components.css:229` | `.numeral` | `letter-spacing` | `-0.06em` | `calc(-0.06em + var(--trk-display))` |
| `components.css:288` | `.dot` | `background` | `var(--ink)` | `var(--progress)` |
| `components.css:350` | `.diamond--done` | `border-color` | `var(--ink)` | `var(--progress)` |
| `components.css:351` | `.diamond--done` | `background` | `var(--ink)` | `var(--progress)` |
| `components.css:356` | `.diamond--stale` | `border-color` | `rgba(21, 20, 18, 0.4)` | `var(--diamond-stale)` |
| `components.css:380` | `.chip:hover` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `components.css:385` | `.chip[aria-pressed="true"], .chip.is-on` | `border-color` | `var(--ink)` | `var(--fill-strong)` |
| `components.css:386` | `.chip[aria-pressed="true"], .chip.is-on` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `components.css:387` | `.chip[aria-pressed="true"], .chip.is-on` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `components.css:415` | `.seg__opt[aria-pressed="true"], .seg__opt.is-on` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `components.css:416` | `.seg__opt[aria-pressed="true"], .seg__opt.is-on` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `components.css:458` | `.bar__fill` | `background` | `var(--ink)` | `var(--progress)` |

### B1 · 7 змін

| Файл:рядок | Селектор | Властивість | Було | Стає |
|---|---|---|---|---|
| `chat.css:102` | `.ch-bubble` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `chat.css:103` | `.ch-bubble` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `chat.css:142` | `.ch-card--active` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `chat.css:229` | `.ch-composer--editing` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `chat.css:255` | `.ch-composer:focus-within` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `chat.css:301` | `.ch-retry` | `border` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `chrome.css:162` | `.tl-passed` | `background` | `repeating-linear-gradient(90deg, var(--ink) 0 1px, transparent 1px 8px)` | `repeating-linear-gradient(90deg, var(--progress) 0 1px, transparent 1px 8px)` |

### B2 · 26 змін

| Файл:рядок | Селектор | Властивість | Було | Стає |
|---|---|---|---|---|
| `cp-board.css:31` | `.cd-approve__price` | `border-left` | `1px solid color-mix(in srgb, var(--on-ink) 28%, transparent)` | `1px solid color-mix(in srgb, var(--on-fill-strong) 28%, transparent)` |
| `cp-board.css:32` | `.cd-approve__price` | `color` | `color-mix(in srgb, var(--on-ink) 82%, transparent)` | `color-mix(in srgb, var(--on-fill-strong) 82%, transparent)` |
| `cp-board.css:138` | `.cd-still` | `outline` | `1px solid var(--line-soft)` | `1px solid var(--media-ring)` |
| `cp-board.css:224` | `.cd-sheet__img` | `outline` | `1px solid var(--line-soft)` | `1px solid var(--media-ring)` |
| `cp-board.css:236` | `.cd-sheet__link:hover .cd-sheet__img` | `outline-color` | `var(--ink)` | `var(--edge-strong)` |
| `cp-board.css:322` | `.cd-wave__bar.is-played` | `background` | `var(--ink)` | `var(--progress)` |
| `cp-brand.css:4` | `.cb` | `--cb-tile-line` | `rgba(21, 20, 18, 0.14)` | `— видалити рядок (→ --line-tile у tokens.css)` |
| `cp-brand.css:5` | `.cb` | `--cb-add-line` | `rgba(21, 20, 18, 0.25)` | `— видалити рядок (→ --line-dashed у tokens.css)` |
| `cp-brand.css:97` | `.cb-swatch` | `box-shadow` | `inset 0 0 0 1px var(--line-soft)` | `inset 0 0 0 1px var(--media-ring)` |
| `cp-brand.css:184` | `.cb-logo` | `border` | `1.5px solid var(--cb-tile-line)` | `1.5px solid var(--line-tile)` |
| `cp-brand.css:186` | `.cb-logo` | `background` | `var(--card)` | `var(--logo-plate)` |
| `cp-brand.css:192` | `button.cb-logo:hover:not(:disabled)` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cp-brand.css:196` | `.cb-logo.is-on` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cp-brand.css:227` | `.cb-logo__badge` | `background` | `var(--ink)` | `var(--media-bg)` |
| `cp-brand.css:228` | `.cb-logo__badge` | `color` | `var(--on-ink)` | `var(--on-media)` |
| `cp-brand.css:234` | `.cb-logo--text` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cp-brand.css:359` | `.cb-photo--add` | `border` | `1.5px dashed var(--cb-add-line)` | `1.5px dashed var(--line-dashed)` |
| `cp-brand.css:369` | `.cb-photo--add:hover:not(:disabled)` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cp-brand.css:443` | `.cb-fmt` | `border` | `1.5px solid var(--cb-tile-line)` | `1.5px solid var(--line-tile)` |
| `cp-brand.css:453` | `.cb-fmt:hover:not(:disabled)` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cp-brand.css:457` | `.cb-fmt.is-on` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cp-script.css:76` | `.cs-block--ink` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `cp-script.css:77` | `.cs-block--ink` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `done.css:68` | `.dn-frame:not(.stripes)` | `background` | `var(--ink)` | `var(--media-bg)` |
| `done.css:159` | `.dn-scrub__fill` | `background` | `var(--ink)` | `var(--progress)` |
| `done.css:304` | `.dn-cost--total .dn-cost__stage, .dn-cost--total .dn-cost__usd` | `border-top` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |

### B3 · 12 змін

| Файл:рядок | Селектор | Властивість | Було | Стає |
|---|---|---|---|---|
| `auth.css:90` | `правило з font 300 44px (:89)` | `letter-spacing` | `-0.05em` | `calc(-0.05em + var(--trk-display))` |
| `auth.css:194` | `.au-input` | `border-bottom` | `1.5px solid var(--ink)` | `1.5px solid var(--edge-strong)` |
| `auth.css:315` | `правило з font 200 112px (:314)` | `letter-spacing` | `-0.06em` | `calc(-0.06em + var(--trk-display))` |
| `auth.css:335` | `.au-short` | `border` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `auth.css:384` | `.au-submit__spin` | `border` | `1.5px solid rgba(245, 243, 238, 0.3)` | `1.5px solid color-mix(in srgb, var(--on-fill-strong) 30%, transparent)` |
| `auth.css:385` | `.au-submit__spin` | `border-top-color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `session.css:46` | `правило з font 300 64px (:45)` | `letter-spacing` | `-0.05em` | `calc(-0.05em + var(--trk-display))` |
| `shortage.css:12` | `.sh` | `border` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `start.css:92` | `.st-url` | `border-bottom` | `1.5px solid var(--ink)` | `1.5px solid var(--edge-strong)` |
| `start.css:111` | `.st-submit__spinner` | `border-color` | `color-mix(in srgb, var(--on-ink) 30%, transparent)` | `color-mix(in srgb, var(--on-fill-strong) 30%, transparent)` |
| `start.css:112` | `.st-submit__spinner` | `border-top-color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `start.css:233` | `.st-manual__text:hover, .st-manual__text:focus` | `border-color` | `var(--ink)` | `var(--edge-strong)` |

### B4 · 44 змін

| Файл:рядок | Селектор | Властивість | Було | Стає |
|---|---|---|---|---|
| `account.css:79` | `.ac-pill__plus:hover` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `account.css:80` | `.ac-pill__plus:hover` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `account.css:131` | `.ac-trigger:hover` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `account.css:135` | `.ac-trigger--open` | `border-color` | `var(--ink)` | `var(--fill-strong)` |
| `account.css:136` | `.ac-trigger--open` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `account.css:137` | `.ac-trigger--open` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `account.css:150` | `.ac-menu` | `border` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `admin.css:98` | `.adm-thead` | `border-bottom` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `admin.css:147` | `.adm-search__input:hover, .adm-search__input:focus` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `admin.css:280` | `.adm-mails` | `border-top` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `admin.css:352` | `.adm-tag--on` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `admin.css:470` | `правило з font 300 28px (:469)` | `letter-spacing` | `-0.04em` | `calc(-0.04em + var(--trk-display))` |
| `admin.css:494` | `правило з font 200 72px (:493)` | `letter-spacing` | `-0.06em` | `calc(-0.06em + var(--trk-display))` |
| `admin.css:567` | `.adm-field__input:hover, .adm-field__input:focus` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `admin.css:594` | `.adm-confirm` | `border` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `admin.css:634` | `.adm-submit__spinner` | `border-color` | `color-mix(in srgb, var(--on-ink) 30%, transparent)` | `color-mix(in srgb, var(--on-fill-strong) 30%, transparent)` |
| `admin.css:635` | `.adm-submit__spinner` | `border-top-color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `cab-balance.css:23` | `.cab-bal__return` | `border` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `cab-balance.css:60` | `правило з font 200 148px (:59)` | `letter-spacing` | `-0.06em` | `calc(-0.06em + var(--trk-display))` |
| `cab-balance.css:128` | `.cab-bal__continue:hover:not(:disabled)` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `cab-balance.css:129` | `.cab-bal__continue:hover:not(:disabled)` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `cab-balance.css:166` | `.cab-tu__tile:hover` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cab-balance.css:170` | `.cab-tu__tile[aria-checked="true"]` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cab-balance.css:199` | `.cab-tu__check` | `background` | `var(--ink)` | `var(--fill-strong)` |
| `cab-balance.css:200` | `.cab-tu__check` | `color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `cab-balance.css:213` | `правило з font 300 40px (:212)` | `letter-spacing` | `-0.05em` | `calc(-0.05em + var(--trk-display))` |
| `cab-balance.css:265` | `правило з font 300 32px (:264)` | `letter-spacing` | `-0.04em` | `calc(-0.04em + var(--trk-display))` |
| `cab-balance.css:275` | `.cab-tu__tile--custom[aria-checked="true"] .cab-tu__input` | `border-bottom-color` | `var(--ink)` | `var(--edge-strong)` |
| `cab-balance.css:297` | `.cab-tu__spinner` | `border-color` | `rgba(245, 243, 238, 0.3)` | `color-mix(in srgb, var(--on-fill-strong) 30%, transparent)` |
| `cab-balance.css:298` | `.cab-tu__spinner` | `border-top-color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `cab-history.css:62` | `.cab-hist__head` | `border-bottom` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `cab-profile.css:43` | `.cab-prof__input:hover, .cab-prof__input:focus` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cab-profile.css:48` | `.cab-prof__input:focus-visible` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cab-profile.css:157` | `.cab-prof__submit .spinner` | `border-color` | `color-mix(in srgb, var(--on-ink) 30%, transparent)` | `color-mix(in srgb, var(--on-fill-strong) 30%, transparent)` |
| `cab-profile.css:158` | `.cab-prof__submit .spinner` | `border-top-color` | `var(--on-ink)` | `var(--on-fill-strong)` |
| `cab-projects.css:61` | `.cab-proj__card:hover, .cab-proj__card.is-open` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `cab-projects.css:92` | `.cab-proj__dot` | `background` | `var(--ink)` | `var(--progress)` |
| `cab-projects.css:232` | `.cab-proj__part--total` | `border-top` | `1px solid var(--ink)` | `1px solid var(--edge-strong)` |
| `cabinet.css:72` | `.cab-nav__item[aria-current="page"]` | `border-color` | `var(--ink)` | `var(--edge-strong)` |
| `checkout.css:66` | `.co-tag` | `border` | `1px dashed rgba(21, 20, 18, 0.25)` | `1px dashed var(--line-dashed)` |
| `checkout.css:113` | `правило з font 200 168px (:112)` | `letter-spacing` | `-0.06em` | `calc(-0.06em + var(--trk-display))` |
| `checkout.css:125` | `правило з font 300 56px (:124)` | `letter-spacing` | `-0.05em` | `calc(-0.05em + var(--trk-display))` |
| `checkout.css:152` | `.co-btn__spinner` | `border-color` | `rgba(245, 243, 238, 0.3)` | `color-mix(in srgb, var(--on-fill-strong) 30%, transparent)` |
| `checkout.css:153` | `.co-btn__spinner` | `border-top-color` | `var(--on-ink)` | `var(--on-fill-strong)` |

## Додаток B. Перемикач теми

### B.1 Рішення

- **Режими:** Світла · Темна · Як у системі.
  - Двох режимів мало: користувач із темною ОС мусив би вмикати темну вручну, а після явного вибору вже не повернувся б до «авто».
  - За замовчуванням — «Як у системі» і для гостя, і для нового користувача: поважаємо ОС, а більшість ОС світлі, тож характер продукту за замовчуванням не змінюється.
- **Розміщення** — варіант B з еталона (SW1): група «Тема» в меню акаунта + коло для гостя на старті.
  - Варіант A (коло в кожному топбарі) відхилено: на 390 ряд старту користувача не вміщується (115 + 140 + 20 + 32 + 20 + 32 = 359 > 342 px), а міняти відступи заборонено. До того ж налаштування «раз і назавжди» не варте постійного місця в 56-px топбарі.
  - Варіант C (сегмент у профілі) відхилено: він лише для користувача, 3+ кліки і перехід зі сцени посеред генерації.
  - `account-controls.js` монтується в усіх оболонках користувача: старт (`place: "start"`), топбари воркспейсу, кабінету й адмінки (`place: "page"`), checkout. Тож одне місце покриває всі п’ять.
  - Гостю меню акаунта недоступне, а кабінет, адмінка й checkout вимагають входу — тому гість отримує коло лише на старті.
  - У модалці входу перемикача немає: це тимчасовий діалог із пасткою фокуса; тема доступна з шапки старту під нею. Модалку перевіряємо в обох темах (Додаток E).
- **Гліф режиму** повторює мову ромбів: контур — світла, заповнене коло — темна, половина — як у системі. Це три кола 12 px з рамкою 1.5 px `currentColor`, без SVG.

### B.2 Модуль `static/js/views/theme-switch.js`

```js
import { getTheme, setThemePref, subscribeTheme } from "../lib/theme.js";
export const THEME_LABELS = { light: "Світла", dark: "Темна", system: "Як у системі" };
/** «Тема: світла» | «Тема: темна» | «Тема: як у системі, зараз темна» */
export function themeTriggerLabel(s) {}
/** Коло гостя + власне меню. @returns {ViewHandle} */
export function mountThemeButton(el, ctx) {}
/** Група для меню акаунта. items — у порядку DOM, для фокус-циклу меню. */
export function themeMenuGroup() {} // → { el: HTMLElement, items: HTMLElement[], destroy(): void }
```

Розмітка (через `h()` з `static/js/dom.js`, без `innerHTML`):

```
div.tm
  button.tm-trigger type=button aria-haspopup="menu" aria-expanded aria-label=themeTriggerLabel(s)
    span.tm-glyph[data-mode=light|dark|system] aria-hidden=true
  div.tm-menu role=menu aria-label="Тема"        ← лише коли відкрито
    div.tm-group role=group aria-label="Тема"
      span.tm-label aria-hidden=true "Тема"
      button.tm-item role=menuitemradio aria-checked tabindex=-1  × 3
        span.tm-glyph[data-mode] aria-hidden · span.tm-item__label · span.tm-item__meta (лише system: «зараз темна|світла») · span.tm-item__check aria-hidden («✓» або "")
```

`themeMenuGroup()` повертає той самий `div.tm-group` з трьома `button.tm-item`.

### B.3 Вставка

- `account-controls.js`, `buildMenu()`:
  - між `.ac-menu__list` і `.ac-menu__foot` додати `themeMenuGroup().el`;
  - його `items` вставити в масив `items` після пунктів списку й перед «Вийти»;
  - при `close()` викликати `destroy()` групи (відписка від `subscribeTheme`).
- Клік на пункт теми — `setThemePref(mode)`. Меню **не закривається**, фокус лишається на пункті, `aria-checked` і `✓` оновлюються з `subscribeTheme`.
- Решта пунктів, як і раніше, йде через `choose()`.
- `start.js`, `renderHead()`: у гілці `status === "anon"` замість `accountEl.append(loginBtn)` — `accountEl.append(themeHost, loginBtn)`. `themeHost` — `span`, у який один раз монтується `mountThemeButton`; при зміні `headKind` викликати `destroy()`. У гілці `ready` нічого не додавати — група вже є в меню акаунта.
- `dev/fixtures/start.js`: фікстура `"n3-guest-theme": guest()`, яка після монтування відкриває меню теми — за зразком `MENU_OPEN` у `dev/fixtures/topbar.js`.

### B.4 `static/css/theme-switch.css` (повністю)

```css
/* .tm- · B5 · перемикач теми (SW). Коло гостя на старті + група «Тема» в меню акаунта. */
.tm {
  position: relative;
  display: inline-flex;
  flex: none;
}

.tm-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  transition: border-color var(--t-hover);
}

.tm-trigger:hover {
  border-color: var(--edge-strong);
}

.tm-trigger:active,
.tm-trigger[aria-expanded="true"] {
  border-color: var(--fill-strong);
  background: var(--fill-strong);
  color: var(--on-fill-strong);
}

.tm-glyph {
  position: relative;
  display: block;
  flex: none;
  width: 12px;
  height: 12px;
  overflow: hidden;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.tm-glyph[data-mode="dark"] {
  background: currentColor;
}

.tm-glyph[data-mode="system"]::after {
  content: "";
  position: absolute;
  inset: 0 50% 0 0;
  background: currentColor;
}

/* Меню гостя: 272 · padding 6 · рамка --edge-strong · радіус 14 · без тіні — як .ac-menu. */
.tm-menu {
  position: absolute;
  z-index: 40;
  top: 42px;
  right: -8px;
  display: flex;
  flex-direction: column;
  width: 272px;
  padding: 6px;
  border: 1px solid var(--edge-strong);
  border-radius: var(--r-14);
  background: var(--card);
  color: var(--ink);
  animation: adc-fade 0.25s var(--ease) both;
}

.tm-group {
  display: flex;
  flex-direction: column;
}

.ac-menu .tm-group {
  padding-bottom: 6px;
  border-top: 1px solid var(--line);
}

.tm-label {
  padding: 10px 12px 6px;
  color: var(--muted);
  font: 500 10.5px / 1.2 var(--f-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ac-menu .tm-label {
  padding-top: 12px;
}

.tm-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-10);
  background: transparent;
  color: var(--ink);
  font: 500 13.5px / 1 var(--f-ui);
  text-align: left;
  cursor: pointer;
}

.tm-item:hover {
  background: var(--paper);
}

.tm-item__label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
}

.tm-item__meta {
  flex: none;
  color: var(--muted);
  font: 400 11.5px / 1 var(--f-mono);
  white-space: nowrap;
}

.tm-item__check {
  flex: none;
  width: 12px;
  color: var(--ink);
  font: 500 11.5px / 1 var(--f-mono);
  text-align: right;
}

/* 390: ціль 44 — коло дорівнює висоті «Увійти» на 390 (start.css), пункти теми 44.
   Інші пункти меню акаунта лишаються 40 — їхні розміри не змінюємо. */
@media (max-width: 560px) {
  .tm-trigger {
    width: 44px;
    height: 44px;
  }

  .tm-menu {
    top: 54px;
  }

  .tm-item {
    height: 44px;
  }
}
```

### B.5 Стани контрола (див. SW2, SW3)

| Стан | Коло (гість) | Пункт меню |
|---|---|---|
| default | рамка `--line-strong`, гліф `--ink` | тло прозоре |
| hover | рамка `--edge-strong` | тло `--paper` |
| focus-visible | глобальний outline 2px `--focus-ring`, offset 2 | те саме |
| active / відкрито | тло й рамка `--fill-strong`, гліф `--on-fill-strong` | — |
| обраний | — | `aria-checked="true"`, `✓` `--ink` |
| system | гліф-половина; підпис «як у системі, зараз …» | meta «зараз темна/світла» `--muted` |

Перевіряється в обох темах, на 1440 і на 390.

### B.6 Клавіатура і ARIA

- Тригер (гість):
  - Enter, Space або ↓ відкривають меню з фокусом на обраному пункті; ↑ — з фокусом на останньому.
  - Esc при відкритому меню закриває його.
- Меню акаунта лишає поточну поведінку: відкривається з фокусом на першому пункті. Стрілки проходять через пункти теми, бо вони в `items`.
- У меню:
  - ↑, ↓, Home, End — циклічно;
  - Enter або Space на `menuitemradio` — вибрати, меню лишається відкритим;
  - Esc — закрити, фокус на тригер;
  - Tab — закрити, далі браузер (як `onMenuKey` в `account-controls.js`).
- Клік поза меню закриває його (`pointerdown` у capture, як у меню акаунта).
- Порядок Tab збігається з видимим: у шапці старту гостя — коло, потім «Увійти».

## Додаток C. Пограничні випадки і рішення

| Випадок | Рішення |
|---|---|
| `--ink` як заливка/рамка/прогрес | Розщеплено на `--fill-strong`, `--edge-strong`, `--focus-ring`, `--progress`, `--media-bg`; у світлій усі = `#151412`. |
| Обраний chip / відкрите коло | Рамка = заливка (`--fill-strong`), інакше в темній навколо світлої заливки лягло б тьмяніше кільце `--edge-strong`. |
| Ієрархія поверхонь | Порядок як у світлій: чат 0.201 < сторінка 0.219 < сцена 0.236 < картка 0.262 (L oklch); кроки ×1.4–1.7 від світлих. Хрома ≤ 0.009, тон h 75. |
| Тінь плеєра | Тінь від `--media-bg` α 0.72 (сцена L 0.236 має куди темніти) + кільце 1px α 0.10 від `--ink`. Підкладка кадру `--media-bg` L 0.145 — найтемніше на екрані. |
| Акцент на темному | Окремий `#ef5e41` (той самий тон h 33, L 0.665): як текст на картці — 4.67:1 (старий `#d4402a` дав би 3.5). `--on-accent` у темній — темний (5.24:1 замість білого 3.2). |
| `--danger`, `--ok`, `--danger-line`, `--danger-field` | Світліші варіанти того ж тону; `--danger` на картці 5.42:1. |
| Hover primary | `--on-fill-strong` на `--accent`: світла 4.15:1 (існуюче, не змінюємо), темна 5.24:1. |
| Темний лого на темній картці, прозорий PNG | Плита `--logo-plate`: світла = `--card`, темна L 0.86 `#d4d0cb`. Чорний лого 12.3:1. Білий лого на прозорому тлі нечитабельний в обох темах, як і зараз (світла 1.03, темна 1.53). Адаптивна плита потребує аналізу пікселів — поза скоупом. |
| Бейдж ✓ на плиті лого | `--media-bg` / `--on-media` замість `--ink` / `--on-ink`: на світлій плиті в темній темі бейдж лишається темним. |
| Свотч, що збігається з фоном (`#1c1a18`, `#111`) | Кільце `--media-ring` (α 0.14 від `--ink` у темній); без нього 1.12:1. Текст на свотчі обирає `cp-brand.js` за брендом — це дані, виняток із R1. |
| Темні стіли (s3-b `#1e1410` на сцені 1.09:1) | Кільце `--media-ring` тримає край. |
| Неон, `#fff` у даних | Не перефарбовуємо. |
| Типографіка на темному | Іррадіація: світлий текст «розпливається», просвіти при −0.05…−0.06em злипаються. Правила з `font: … var(--f-display)` ≥ 28px отримують `+ var(--trk-display)` (темна 0.006em). Вага не змінюється — кроку між 200 і 300 у підключених накресленнях немає. |
| `#000` / `#fff` | У темному блоці їх немає (R5): найтемніше — `--media-bg` `#0b0a08`, найсвітліше — `--ink` `#ebe7e2`. |
| `color-scheme` | `:root { color-scheme: light }` / `[data-theme=dark] { color-scheme: dark }` — нативні скролбари (`#stage`, сторінка), контроли `<video>`, поля. Власних стилів скролбара немає й не додаємо. |
| `theme-color` | Мета зі значенням `--paper` теми; ставить boot, оновлює `theme.js`. |
| `caret-color` | У CSS не задано — каретка `currentColor` = `--ink`, працює сама. |
| `::placeholder` | Уже `var(--muted)` (`start.css`, `auth.css`, `chat.css`, `admin.css`) — 5.90:1 на темній сторінці. |
| `-webkit-autofill` | Лише в темній: `-webkit-text-fill-color: var(--ink)` + трюк із transition — тло поля лишається прозорим. Поля виключено з `data-theme-switching`. |
| `::selection` | `--fill-strong` / `--on-fill-strong`. |
| Смугастий плейсхолдер | `--placeholder-a/b` `#292724` / `#23211e` — ΔL 0.025, як у світлій. |
| `--scrim`, `--veil` | Від `--media-bg` / `--paper` теми; `--scrim` α 0.62 — модалка відділяється від темної сторінки. |
| Спінери на primary | `color-mix(in srgb, var(--on-fill-strong) 30%, transparent)` — пікселі ті самі, що `rgba(245,243,238,.3)` у світлій; у темній перевертається разом із заливкою. |
| `--disabled-fill` | α 0.20 у темній. Неактивні контроли не вимагають контрасту (WCAG 1.4.3). |
| Рамки ghost-кнопок, чипів | `--line-strong` нижче 3:1 в обох темах — кнопку ідентифікує підпис (WCAG 1.4.11), як і зараз. Межі, що самі несуть стан (лінія поля, активна рамка, фокус), — `--edge-strong` / `--focus-ring` ≥ 3:1. |
| `adc-ring` | Keyframes уже на `--accent-ring*` — кільце бере темні значення. |
| `ac-delta`, `adc-pulse`, `adc-spin`, `adc-fade`, `sp-indeterminate` | Кольору немає — без змін. |
| Зміна теми посеред генерації | Лише атрибут на `<html>`; без перезавантаження й перемонтування; SSE і store не чіпаємо. |
| Сотні transition одночасно | `data-theme-switching` на кадр вимикає transition; кросфейд робить View Transitions (200 мс). |
| Відео під час кросфейду | VT заморожує знімок на 200 мс — прийнятно; reduced-motion — миттєво. |
| Немає View Transitions (старі Safari/Firefox) | Миттєва зміна. |
| Приватний режим / `localStorage` кидає | Стан у пам’яті; boot бере систему. |
| Фікстура з `&theme=` | Locked: вибір у перемикачі застосовується, але не пишеться; події `storage` ігноруються. |
| Мобільні (`#workspace`, `#cabinet`, `#admin` min-width 1024) | 390 — лише старт, модалка входу, checkout. |

## Додаток D. Скоуп і поза скоупом

**У скоупі:** усі 22 файли `static/css`, `index.html`, `app.js`, `theme-boot.js`, `lib/theme.js`, перемикач (`theme-switch.js/.css`, вставки в `account-controls.js` і `start.js`), фікстура `n3-guest-theme`, тестові лого, тести, еталон у `docs/design`.

**Поза скоупом (зафіксовано):**

- `/stats` (`src/routes/stats.ts`) — голий HTML без CSS, адмінський звіт; браузер малює його світлим. Окреме завдання. (Згодом сторінку `/stats` видалено; витрати — у вкладці адмінки «Використання».)
- Листи в outbox — їх рендерять поштові клієнти, у них свої шаблони.
- Рендер відео (Remotion, `apps/remotion`) — кольори ролика належать бренду клієнта.
- Збереження теми на сервері — поля в API немає; вибір живе в браузері (`adc.theme`).
- Адаптивна плита лого за аналізом пікселів.
- `prefers-contrast: more`, режим високої контрастності.
- Будь-які зміни розкладки, розмірів, текстів, шрифтів, радіусів, іконок. Виняток — нові класи `.tm-*`.

## Додаток E. Приймання

Для кожної фікстури з `dev/fixtures/*.js` і `LEGACY_FIXTURES` у `dev/fixture-states.js` відкрити `/?fixture=<id>` і `/?fixture=<id>&theme=dark` на 1440. Для `n3-*`, `n1-*`, `n2-*`, `n15-*` і checkout — ще й на 390. Перевірити:

1. **Світла не змінилась.**
   - Guard R5 зелений: світлі значення нових токенів = старим.
   - diff кожного CSS-файлу містить лише рядки з Додатка A.
   - Вибірково 6 фікстур (`n3-guest`, `awaitingBrand`, `awaitingStoryboard`, `delivered`, `n4-menu`, checkout) на `main` і на `feat/dark-theme` у світлій дають знімки екрана, що збігаються до пікселя (порівняння накладанням у DevTools).
2. Поверхні в темній читаються за порядком: чат < сторінка < сцена < картка. Жодного світлого прямокутника, крім плити лого.
3. Primary, бульбашка, обраний chip/seg/тайл, round — світла заливка з темним текстом. Hover primary — `--accent` з темним текстом.
4. Активні рамки, лінії полів, рамка меню — `--edge-strong`. Фокус з клавіатури видно на кожному контролі.
5. Таймлайн: пройдені тіки й ромби — `--progress`, плейхед і чип — `--accent` / `--on-accent`, `adc-ring` видно.
6. Медіа:
   - стіли, аркуші, свотчі мають кільце;
   - кадр лежить на `--media-bg`, у плеєра є тінь і кільце;
   - лого лежать на плиті;
   - «найгірші бренди» (`logo-*-transparent.svg`, свотчі `#111`, `#fff`, `#39ff14`, `#1c1a18`) — як у секції D еталона.
7. Нативне: темні скролбари, контроли `<video>` і поля; placeholder `--muted`; автозаповнення без жовтого тла; `::selection` інверсна; `theme-color` темний.
8. Під час завантаження з `adc.theme=dark` (і з темною ОС при `system`) немає світлого спалаху. Перевіряти з throttling «Slow 4G».
9. Перемикач:
   - клавіатурний прохід за B.6 на кожному екрані (старт гостя, старт користувача, воркспейс, кабінет, адмінка, checkout);
   - 44px на 390;
   - вибір переживає перезавантаження;
   - друга вкладка перемикається;
   - SSE не рветься: під час генерації `awaitingStoryboard` → рендер тема змінюється, а прогрес триває.
10. Reduced motion: зміна теми миттєва, `adc-ring` / `adc-pulse` / `adc-spin` вимкнені, як і зараз.
11. Контраст — як у Додатку F, рахувати з токенів (еталон, секція T·P).

## Додаток F. Контраст (WCAG 2.x)

| Пара | Токени | Поріг | Світла | Темна | Примітка |
|---|---|---|---|---|---|
| Текст / сторінка | `--ink` / `--paper` | ≥ 4.5 | 16.60 ✓ | 14.10 ✓ |  |
| Текст / діалог | `--ink` / `--chat` | ≥ 4.5 | 16.01 ✓ | 14.67 ✓ |  |
| Текст / сцена | `--ink` / `--stage` | ≥ 4.5 | 17.17 ✓ | 13.51 ✓ |  |
| Текст / картка | `--ink` / `--card` | ≥ 4.5 | 17.79 ✓ | 12.54 ✓ |  |
| Вторинний / сторінка | `--ink-2` / `--paper` | ≥ 4.5 | 10.56 ✓ | 9.59 ✓ |  |
| Вторинний / картка | `--ink-2` / `--card` | ≥ 4.5 | 11.32 ✓ | 8.53 ✓ |  |
| Підпис / сторінка | `--muted` / `--paper` | ≥ 4.5 | 4.85 ✓ | 5.90 ✓ |  |
| Підпис / діалог | `--muted` / `--chat` | ≥ 4.5 | 4.68 ✓ | 6.14 ✓ |  |
| Підпис / сцена | `--muted` / `--stage` | ≥ 4.5 | 5.02 ✓ | 5.66 ✓ |  |
| Підпис / картка | `--muted` / `--card` | ≥ 4.5 | 5.20 ✓ | 5.25 ✓ |  |
| Primary | `--on-fill-strong` / `--fill-strong` | ≥ 4.5 | 16.60 ✓ | 12.84 ✓ |  |
| Primary :hover | `--on-fill-strong` / `--accent` | ≥ 4.5 | 4.15 ⚠ | 5.24 ✓ | світла: існуюче значення, світлу не змінюємо |
| Чип плейхеда | `--on-accent` / `--accent` | ≥ 4.5 | 4.60 ✓ | 5.24 ✓ |  |
| Акцент-текст / картка | `--accent` / `--card` | ≥ 4.5 | 4.44 ⚠ | 4.67 ✓ |  |
| Акцент-текст / сцена | `--accent` / `--stage` | ≥ 4.5 | 4.29 ⚠ | 5.03 ✓ |  |
| Помилка / картка | `--danger` / `--card` | ≥ 4.5 | 5.75 ✓ | 5.42 ✓ |  |
| Помилка / сцена | `--danger` / `--stage` | ≥ 4.5 | 5.55 ✓ | 5.84 ✓ |  |
| Бейдж ✓ на плиті лого | `--on-media` / `--media-bg` | ≥ 4.5 | 16.60 ✓ | 16.08 ✓ |  |
| Плейхед / таймлайн | `--accent` / `--paper` | ≥ 3 | 4.15 ✓ | 5.24 ✓ |  |
| Активна рамка / картка | `--edge-strong` / `--card` | ≥ 3 | 17.79 ✓ | 7.16 ✓ |  |
| Лінія поля / сторінка | `--edge-strong` / `--paper` | ≥ 3 | 16.60 ✓ | 8.05 ✓ |  |
| Фокус / сцена | `--focus-ring` / `--stage` | ≥ 3 | 17.17 ✓ | 13.51 ✓ |  |
| Ромб idle / сторінка | `--diamond-idle` / `--paper` | ≥ 3 | 2.93 ⚠ | 3.85 ✓ | світла: існуюче значення, світлу не змінюємо |
| «На зв’язку» / діалог | `--ok` / `--chat` | ≥ 3 | 3.51 ✓ | 6.67 ✓ |  |

У темній темі пар нижче порогу: 0. ⚠ — існуючі значення світлої теми, які за умовою ТЗ не змінюються.
