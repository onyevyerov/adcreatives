# `@adc/motion-kit` — контракт B3 / B4, версія 0

Цей файл — для розробників. Опис поведінки компонентів, який читає модель codegen/code-fix, — у `API.md`
(підставляється в промпти як `{{motionKitApi}}`); декларації з `.d.ts` — в `API.generated.md`
(`pnpm --filter @adc/motion-kit docs`); правила для сцен (дозволені імпорти, заборонені конструкції,
формат файлу) — у `prompts/codegen.md` і `prompts/code-fix.md`, їх перевіряє AST-guard у B4.

Контракт між B3 (реалізація, хост Remotion) і B4 (codegen сцен). Зафіксовано в Кроці 0.
До кінця хвилі 2 змінюється лише міні-PR власника B3 на запит B4 (після кожної зміни B3
перегенеровує `API.generated.md`); після хвилі 2 — заморожено.

Увага: `API.md` і `API.generated.md` входять у хеш контексту codegen (`packages/director/src/context.ts`).
Будь-яка зміна цих файлів робить недійсним кеш усіх сцен — наступна ревізія будь-якого проєкту
перегенерує їх повністю.

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
- Дозволені імпорти: `react` (без `useState`, `useEffect`, `useLayoutEffect`; `useMemo`, `useRef` — можна),
  `remotion` (`useCurrentFrame`, `useVideoConfig`, `interpolate`, `spring`, `Easing`, `AbsoluteFill`, `Sequence`),
  `@remotion/layout-utils`, `@remotion/shapes`, `@remotion/paths`, `@adc/motion-kit`.
- Кадр 0 сцени = початок її послідовності; `durationInFrames` включає перекриття переходами
  (див. `computeTimeline` у `@adc/shared/timeline`). Стіли знімаються на 50% і 90% тривалості;
  вимоги до часу появи тексту — у `prompts/codegen.md` (розділ Timing).

## Публічний API для сцен

Перелік експортів — `API.generated.md`; поведінка, дефолти й QA-логи кожного компонента — `API.md`.
Групи: тема (`ThemeProvider` ставить хост; `useTheme`, `readableOn`, `mix`, `withAlpha`, `contrastRatio`,
`isDark`, `minContrastFor`), формат і safe-зона (`useFormat`, `SafeArea`, `formatInfoFor`, `SAFE_MARGINS`,
`isInsideRect`), текст (`FitText`, `KineticText`, `Headline`, `Body`, `Pill`, `CTAButton`), зображення
(`BrandImage`, `Logo`), фон (`Backdrop`), рух (`springs`, `easings`, `progress`, `springFor`, `defaultStagger`),
девайси (`useBeat`, `ColorField`, `ClipReveal`, `DrawPath`, `MorphShape`, `Breathe`),
чисті хелпери розкладки тексту (`fitText`, `markEmphasis`, `headingWeight`, `bodyWeight` тощо).

Шрифти — через `@remotion/google-fonts` з `subsets: ["latin", "cyrillic"]` і лише потрібними `weights`
(з `brand.typography`); `ThemeProvider` чекає їх завантаження (`delayRender`) і не малює дітей до того.
Метадані шрифтів (`fonts`, `FontInfo` з `@remotion/google-fonts`) резолвить `@adc/render` у Node і передає
в inputProps — у бандл не потрапляють ~1800 модулів шрифтів.

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
`upscaled_image`, `low_contrast`, `missing_asset` (невідомий `assetId` у `BrandImage`).
Стадія `check` збирає їх через `onBrowserLog`. Однаковий запис логується раз на монтування компонента.

## Типи (реекспорт із `@adc/shared`)

```ts
interface SceneProps { scene: Scene; brand: BrandKit; assets: Record<string, AssetRef>; durationInFrames: number }
interface MainProps { brand: BrandKit; storyboard: Storyboard; format: Format; assets: Record<string, AssetRef>;
                      audio: AudioManifest; templateScenes: string[]; qa?: boolean }
interface AssetRef { src: string; width: number; height: number; focal: { x: number; y: number } }
```

## Еталонні сцени

`packages/motion-kit/examples/*.tsx` — 5 сцен-жанрів (hook з фото, оффер із ціною, типографічна сцена,
proof, CTA з лого), `device-reveal.tsx` (еталон девайсів) і `ui-demo.tsx` (еталон прийомів інтерфейсу:
поле → скан → список із галочками + лічильник; тексти з `items`, моменти через `eventFrame`). Компілюються в тестах і підставляються
в промпт `codegen` як зразки (через спільний префікс `prompts/motion-reference.md`).

## Зміни після Кроку 0 (B3, хвиля 1)

Усі зміни сумісні (лише додано необов'язкове):
- `readableOn(background, palette?)` — другий параметр, бо функція поза хуком не знає палітри бренду.
- `ThemeProvider` — необов'язковий `fonts?: FontInfo[]` (метадані Google Fonts від рендера).
- `Headline`/`Body`/`KineticText` — `width?`, `style?`; `Body` — `emphasis?`; `Pill`/`CTAButton` — `style?`.
- Лише для хоста: `AssetsProvider`, `SceneDurationProvider`, `parseQaLog`; контракт `scenes/index.ts` (default export реєстру).
- Додаткові чисті хелпери (не обов'язкові для сцен): `formatInfoFor`, `SAFE_MARGINS`, `mix`, `withAlpha`,
  `contrastRatio`, `fitText`, `markEmphasis`, `headingWeight`, `bodyWeight` тощо — див. `API.generated.md`.

## Зміни після хвилі 3 (поведінка, узгоджена з `API.md`)

Сигнатури не змінюються; змінюється поведінка трьох компонентів:
- `BrandImage.startFrame` — до цього кадру фото невидиме, далі fade-in за 10 кадрів (`easings.out`);
  Ken Burns і паралакс стартують з `startFrame` (раніше `startFrame` лише зсував старт Ken Burns).
- `BrandImage` з `mask: { type: "rounded" }` без `radius` — `theme.radius.lg × unit` (раніше без `× unit`).
- `Pill` і `CTAButton` підбирають кегль під доступну ширину (до 60% номіналу) і пишуть QA-логи
  `text_min_size` / `text_overflow` (раніше — фіксований кегль, `nowrap`, без логу).

## Девайси (B4, оптимізація вартості й якості)

Готові прийоми замість ручної математики в сценах (`src/devices/`); сумісно — лише додано експорти.
Поведінка й приклади — `API.md`, розділ `## Devices`; сигнатури — `API.generated.md`.

- `useBeat(at, opts?)` — 0→1 від кадру `at`: пружина `springFor(theme.motion)` або `progress` за `duration`.
- `ColorField` — поле палітри: `wipe` / `split` / `push` (`cover`, `exitFrame`); діти — кадр під полем.
- `ClipReveal` — відкриття дітей через `clipPath`: `inset` / `circle` / `polygon`, `from` — край або центр.
- `DrawPath` — SVG-лінія, що малюється (`evolvePath` з `@remotion/paths`).
- `MorphShape` — заокруглена форма між ключовими станами (`x`, `y`, `width`, `height`, `radius`, колір).
- `Breathe` — «дихання» шару на весь кадр після появи тексту (детермінований період за `theme.motion`).

Інваріанти (перевіряє `test/devices.test.tsx`):
- чиста функція кадру: без стану й ефектів, той самий кадр → та сама розмітка;
- clamp: до старту — початковий стан, після кінця — кінцевий, без екстраполяції;
- колір — лише роль палітри (`keyof Palette`), не CSS-рядок; між ролями — `mix()` двох кольорів палітри;
- дефолтні px × `unit` (`strokeWidth`, `radius`); центр `Breathe` — центр safe-зони;
- QA: `DrawPath` і `MorphShape` пишуть `outside_safe_area`, якщо не `bleed`; `ColorField` і `MorphShape`
  позначають свій колір (`data-adc-bg`) для перевірки контрасту тексту над ними / в них.

Префікс codegen: examples + `API.md` + `API.generated.md` зросли на ~14 % (80 384 → 91 936 байт).
Посилання на девайси в `prompts/codegen.md` — окремо (B2b, хвиля 2).

## Прийоми інтерфейсу й даних (ТЗ якості відео, B2)

Назви й мінімальні пропси заморожені,
додавати можна лише необов'язкові пропси. Поведінка — `API.md`, розділ «Showing the product»; сигнатури —
`API.generated.md`. Сумісно — лише додано експорти й необов'язкові пропси.

- `Icon` + `IconName` / `ICON_NAMES` — 315 іконок lucide (усі 75 обов'язкових з §2.10 + загальновживані й нішеві: медицина, освіта, нерухомість, транспорт, їжа, спорт, пристрої, дії інтерфейсу),
  шляхи вбудовані як дані (`src/icons/`, ISC — `src/icons/LICENSE-lucide`); `draw` — `pathLength=1` + dasharray.
- `numberIn(text)` — перше число тексту без знака (`findNumber`/`odometer` — внутрішні, `src/ui/number.ts`).
- `CountUp`, `Ring`, `Bars` (`src/ui/data.tsx`); `UICard`, `Checkbox`, `Checklist`, `InputField`, `Cursor`
  (`src/ui/widgets.tsx`); `ScanLine`, `Flash`, `Glow`, `Strike` (`src/ui/effects.tsx`); реекспорт `eventFrame`.
- Необов'язкові пропси понад §2.10: `CountUp.easing`; `Ring.total/durationFrames/track/style`;
  `Bars.max/color/highlight/gap/style`; `UICard.title/icon/width`; `Checkbox.style`;
  `Checklist.checkAt/fontSize/color/checkColor/style`; `InputField.fontSize/style`; `Cursor.size/style`;
  `ScanLine.color/trail`; `Glow.startFrame/style`; `Strike.angle/dim/style`. `Cursor.clickAt` приймає
  також масив кадрів (`number | readonly number[]`) — розширення типу, старі виклики з числом сумісні.
- Текст у `CountUp` і `InputField` іде через внутрішній блок `TextBlock` (той самий, що й у `FitText`;
  новий внутрішній проп `glyphs` підміняє символи без зміни розкладки — одометр і друк), QA-логи —
  з `component` `CountUp` / `InputField`; у `Checklist`, `UICard` (заголовок) і кнопці `InputField` — `FitText`.
- `color` нових прийомів — роль палітри або CSS-колір (`paint()`), дефолти — з теми.
- Фікс `highlight` (`TextBlock`): одна плашка на фразу `emphasis` у рядку (`emphasisPhrases` у `text/layout.ts`),
  відступ 0.1 em вліво, вправо й униз від бокса слів (виносні елементи не торкаються краю).

Інваріанти (перевіряє `test/ui.test.tsx`): той самий кадр → та сама розмітка для кожного прийому;
`Checkbox` до `checkedAt` без галочки; `CountUp` з кадру `startFrame + durationFrames` — рівно `text`;
невідома `IconName` — помилка типу (`@ts-expect-error` у тесті під `tsc`); `highlight` — один прямокутник
на фразу; `ui-demo` рендериться в трьох форматах, а без потрібної події падає з помилкою `eventFrame`.

Префікс codegen: examples + `API.md` + `API.generated.md` зросли на ~36 % (91 936 → 125 292 байти).

## Прогалини якості (ТЗ 2026-10-14)

Сумісно — лише додано експорти `MotionBlur`/`Trail` (`src/devices/blur.tsx`, поверх `@remotion/motion-blur`,
копії-семпли з вимкненим QA), `Camera`/`CameraKey`/`useCamera` (`src/devices/camera.tsx`; QA враховує камеру),
необов'язковий проп `Cursor.hoverAt` і хостовий проп `ThemeProvider.localFonts` (шрифти сайту з `public/fonts/`
через `@remotion/fonts`, `HostExtras.localFonts`); поведінка — `API.md`, еталони — `examples/motion-blur.tsx`,
`examples/camera-cursor.tsx`.
