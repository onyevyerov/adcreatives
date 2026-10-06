# `@adc/motion-kit` — публічний API, версія 0

Контракт між B3 (реалізація, хост Remotion) і B4 (codegen сцен). Зафіксовано в Кроці 0.
До кінця хвилі 2 змінюється лише міні-PR власника B3 на запит B4 (після кожної зміни B3
перегенеровує `API.generated.md` командою `pnpm --filter @adc/motion-kit docs`); після хвилі 2 — заморожено.

Типи даних (`BrandKit`, `Scene`, `Storyboard`, `SceneProps`, `MainProps`, `AssetRef`, `AudioManifest`)
живуть у `@adc/shared` і реекспортуються з `@adc/motion-kit` без змін.

## Правила для сцени (codegen)

```tsx
import type { SceneProps } from "@adc/motion-kit";
export default function Scene(props: SceneProps) { … }
```

- Сцена малює **лише картинку**. Переходи між сценами, звук, порядок сцен — справа хоста.
- Зображення — тільки через `<BrandImage assetId>`; лого — тільки через `<Logo>`.
- Розкладка — через `useFormat()` (сцена рендериться в усіх обраних форматах тим самим кодом).
- Уся анімація — чиста функція від `useCurrentFrame()` (`interpolate`, `spring`, `springs.*`, `easings.*`).
  CSS `transition`/`animation`, `Math.random`, `Date`, таймери заборонені (AST-guard у B4).
- Дозволені імпорти: `react` (без `useState`, `useEffect`, `useLayoutEffect`), `remotion`
  (`useCurrentFrame`, `useVideoConfig`, `interpolate`, `spring`, `Easing`, `AbsoluteFill`, `Sequence`),
  `@remotion/layout-utils`, `@remotion/shapes`, `@remotion/paths`, `@adc/motion-kit`.
- Кадр 0 сцени = початок її послідовності; `durationInFrames` включає перекриття переходами
  (див. `computeTimeline` у `@adc/shared/timeline`). Важливий текст має бути повністю видимим
  між 20% і 85% тривалості сцени (стіли знімаються на 50% і 90%).

## Для сцен

### Тема

```ts
interface Theme {
  palette: BrandKit["palette"];          // primary, secondary, accent, background, surface, textOnDark, textOnLight
  fonts: { heading: string; body: string }; // CSS font-family, вже завантажені
  weights: { heading: number[]; body: number[] };
  radius: { sm: number; md: number; lg: number; pill: number }; // px для unit = 1, з visualStyle.shapes
  motion: MotionPersonality;             // energetic | calm | premium | playful
  density: "airy" | "balanced" | "dense";
}

function ThemeProvider(props: { brand: BrandKit; fonts?: FontInfo[]; children: React.ReactNode }): JSX.Element; // ставить хост
function useTheme(): Theme;
/** Колір тексту з достатнім контрастом для фону (textOnDark / textOnLight); передавайте theme.palette. */
function readableOn(background: string, palette?: { textOnDark: string; textOnLight: string }): string;
```

Шрифти — через `@remotion/google-fonts` з `subsets: ["latin", "cyrillic"]` і лише потрібними `weights`
(з `brand.typography`); `ThemeProvider` чекає їх завантаження (`delayRender`) і не малює дітей до того.
Метадані шрифтів (`fonts`, `FontInfo` з `@remotion/google-fonts`) резолвить `@adc/render` у Node і передає
в inputProps — у бандл не потрапляють ~1800 модулів шрифтів.

### Формат і safe-зона

```ts
type Format = "vertical" | "square" | "landscape";
interface Rect { x: number; y: number; width: number; height: number }
interface FormatInfo {
  format: Format;
  width: number;   // 1080 | 1080 | 1920
  height: number;  // 1920 | 1080 | 1080
  safe: Rect;      // зона, де текст і лого гарантовано не перекриваються інтерфейсом соцмереж
  isVertical: boolean;
  isLandscape: boolean;
  /** Масштаб відносно короткої сторони 1080 — для розмірів шрифтів і відступів. */
  unit: number;
}
function useFormat(): FormatInfo;

/** Контейнер на всю safe-зону; children позиціонуються всередині. */
function SafeArea(props: { children: React.ReactNode; padding?: number; style?: React.CSSProperties }): JSX.Element;
```

### Текст

```ts
type TextPreset = "rise" | "fade" | "scale" | "highlight" | "typewriter";

/** Підбирає розмір шрифту, щоб текст вліз у maxLines рядків ширини box; не менше minFontSize. */
function FitText(props: {
  text: string;
  maxLines?: number;            // дефолт 2
  maxFontSize: number;          // px
  minFontSize: number;          // px; якщо не вліз і на мінімумі — QA-лог text_min_size / text_overflow
  width?: number;               // px, дефолт — ширина safe-зони
  font?: "heading" | "body";
  weight?: number;
  color?: string;
  align?: "left" | "center" | "right";
  style?: React.CSSProperties;
}): JSX.Element;

/** Кінетичний текст: поява по словах або рядках. */
function KineticText(props: {
  text: string;
  preset: TextPreset;
  by?: "word" | "line";         // дефолт "word"
  startFrame?: number;          // дефолт 0
  stagger?: number;             // кадрів між елементами, дефолт залежить від theme.motion
  emphasis?: string[];          // слова з акцентом (колір accent)
  maxLines?: number;            // дефолт 3
  maxFontSize: number;
  minFontSize: number;
  width?: number;               // px, дефолт — ширина safe-зони
  font?: "heading" | "body";
  color?: string;
  align?: "left" | "center" | "right";
  style?: React.CSSProperties;
}): JSX.Element;

/** Заголовок сцени: FitText/KineticText з токенами теми (font heading, вага max). Без preset — статичний.
 *  Дефолти: size "l" (max/min px: m 76/44, l 100/52, xl 128/60 × unit), maxLines 3, align "center". */
function Headline(props: { text: string; emphasis?: string[]; preset?: TextPreset; startFrame?: number; maxLines?: number; size?: "m" | "l" | "xl"; color?: string; align?: "left" | "center" | "right"; width?: number; style?: React.CSSProperties }): JSX.Element;
/** Підзаголовок / основний текст (font body). Дефолти: size "m" (s 34/26, m 42/30, l 54/34 × unit), maxLines 3. */
function Body(props: { text: string; preset?: TextPreset; startFrame?: number; maxLines?: number; size?: "s" | "m" | "l"; color?: string; align?: "left" | "center" | "right"; width?: number; emphasis?: string[]; style?: React.CSSProperties }): JSX.Element;
/** Плашка: ціна, знижка, бейдж. */
function Pill(props: { text: string; startFrame?: number; variant?: "accent" | "primary" | "surface"; size?: "s" | "m" | "l"; style?: React.CSSProperties }): JSX.Element;
/** Кнопка CTA з м'якою пульсацією. */
function CTAButton(props: { text: string; startFrame?: number; variant?: "accent" | "primary"; size?: "m" | "l"; style?: React.CSSProperties }): JSX.Element;
```

### Зображення і лого

```ts
interface Mask { type: "rounded" | "circle" | "blob" | "diagonal"; }

function BrandImage(props: {
  assetId: string;              // ключ з props.assets; невідомий id → нейтральний фон + QA-лог stretched_image
  fit?: "cover" | "contain";    // дефолт "cover"
  focal?: { x: number; y: number }; // дефолт — AssetRef.focal
  kenBurns?: { from: number; to: number; direction?: "in" | "out" | "left" | "right" | "up" | "down" }; // масштаб 1.0–1.25
  parallax?: number;            // px зсуву за сцену
  mask?: Mask;
  radius?: number;
  overlay?: { color: string; opacity: number }; // затемнення під текст
  startFrame?: number;
  style?: React.CSSProperties;  // розмір і позиція контейнера
}): JSX.Element;                // QA-логи stretched_image / upscaled_image

function Logo(props: {
  size?: number;                // висота, px
  variant?: "auto" | "onDark" | "onLight"; // з підкладкою, якщо brand.logo.needsBackground
  startFrame?: number;
  style?: React.CSSProperties;
}): JSX.Element;                // без зображення — brand.logo.textFallback шрифтом heading
```

### Фон

```ts
function Backdrop(props: {
  variant: "solid" | "gradient" | "noise" | "shapes";
  color?: string;               // дефолт palette.background
  colors?: string[];            // для gradient/shapes
  angle?: number;               // для gradient
  animate?: boolean;            // повільний дрейф (функція від кадру)
}): JSX.Element;
```

### Рух

```ts
/** Пресети spring() для remotion: використовувати як spring({ frame, fps, config: springs.soft }). */
const springs: { snappy: SpringConfig; soft: SpringConfig; premium: SpringConfig };
/** Easing-функції для interpolate(..., { easing }). */
const easings: { out: EasingFn; inOut: EasingFn; expoOut: EasingFn; backOut: EasingFn };
/** Хелпер: 0→1 від startFrame за duration кадрів з easing (clamp). */
function progress(frame: number, startFrame: number, duration: number, easing?: EasingFn): number;
```

## Лише для хоста (`apps/remotion`, не для сцен)

```ts
function MusicTrack(props: { audio: AudioManifest; totalFrames: number }): JSX.Element; // fade-out наприкінці
function Sfx(props: { cue: string; audio: AudioManifest; from: number }): JSX.Element;
/** Детерміновані шаблони: hero | text | image | cta; вибір за scene.purpose. */
function TemplateScene(props: SceneProps & { variant?: "hero" | "text" | "image" | "cta" }): JSX.Element;
function templateVariantFor(purpose: ScenePurpose): "hero" | "text" | "image" | "cta";
/** Вмикає QA-режим для дерева: компоненти пишуть ADC_QA-логи. */
function QaProvider(props: { enabled: boolean; children: React.ReactNode }): JSX.Element;
/** Пише рядок `ADC_QA {json}` у console (JSON — QaLogEntry з @adc/shared/schemas). */
function qaLog(entry: QaLogEntry): void;
/** Розбирає рядок логу браузера; не QA-рядок → null (для стадії check). */
function parseQaLog(text: string): QaLogEntry | null;
/** Асети ревізії для BrandImage/Logo і тривалість поточної сцени (kenBurns/parallax) — ставить хост. */
function AssetsProvider(props: { assets: Record<string, AssetRef>; children: React.ReactNode }): JSX.Element;
function SceneDurationProvider(props: { durationInFrames: number; children: React.ReactNode }): JSX.Element;
```

Реєстр сцен задачі (`rev/<n>/video/scenes/index.ts`, генерує codegen; хост імпортує його як `@job/scenes`):

```ts
import S1 from "./s1.tsx";
import S2 from "./s2.tsx";
export default { s1: S1, s2: S2 };   // Record<sceneId, ComponentType<SceneProps>>
```

Сцени, яких немає в реєстрі або які є в `templateScenes`, малює `TemplateScene`. У `Main` сцена, що впала
в runtime, підміняється `TemplateScene` (лог `ADC_SCENE_ERROR {sceneId, message}`); у `ScenePreview` помилка
доходить до `renderStill` (`RenderError` з логами браузера).

QA-режим: кожен компонент, що виявив проблему, пише в консоль браузера
`ADC_QA {"kind":"text_overflow","component":"FitText","detail":"…","value":12,"frame":75}`.
Види (`AutoIssueKind`): `text_overflow`, `text_min_size`, `outside_safe_area`, `stretched_image`,
`upscaled_image`, `low_contrast`. Стадія `check` збирає їх через `onBrowserLog`.
Невідомий `assetId` у `BrandImage` логується як `stretched_image` з detail «невідомий assetId …»
(окремого виду в `AutoIssueKind` немає). Однаковий запис логується раз на монтування компонента.

## Типи (реекспорт із `@adc/shared`)

```ts
interface SceneProps { scene: Scene; brand: BrandKit; assets: Record<string, AssetRef>; durationInFrames: number }
interface MainProps { brand: BrandKit; storyboard: Storyboard; format: Format; assets: Record<string, AssetRef>;
                      audio: AudioManifest; templateScenes: string[]; qa?: boolean }
interface AssetRef { src: string; width: number; height: number; focal: { x: number; y: number } }
```

## Еталонні сцени

`packages/motion-kit/examples/*.tsx` — 4–5 сцен (hook з фото, оффер із ціною, типографічна сцена,
proof, CTA з лого). Компілюються в тестах і підставляються в промпт `codegen` як зразки.

## Зміни після Кроку 0 (B3, хвиля 1)

Усі зміни сумісні (лише додано необов'язкове):
- `readableOn(background, palette?)` — другий параметр, бо функція поза хуком не знає палітри бренду.
- `ThemeProvider` — необов'язковий `fonts?: FontInfo[]` (метадані Google Fonts від рендера).
- `Headline`/`Body`/`KineticText` — `width?`, `style?`; `Body` — `emphasis?`; `Pill`/`CTAButton` — `style?`.
- Лише для хоста: `AssetsProvider`, `SceneDurationProvider`, `parseQaLog`; контракт `scenes/index.ts` (default export реєстру).
- Додаткові чисті хелпери (не обов'язкові для сцен): `formatInfoFor`, `SAFE_MARGINS`, `mix`, `withAlpha`,
  `contrastRatio`, `fitText`, `markEmphasis`, `headingWeight`, `bodyWeight` тощо — див. `API.generated.md`.
