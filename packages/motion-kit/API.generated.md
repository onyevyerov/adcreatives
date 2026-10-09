# `@adc/motion-kit` — декларації API (згенеровано)

> Не редагувати вручну. Згенеровано з `.d.ts` командою `pnpm --filter @adc/motion-kit docs`.
> Контракт і правила для сцен — `CONTRACT.md`; еталонні сцени — `examples/*.tsx`.

## Вхід пакета (`@adc/motion-kit`)

`src/index`

```ts
/**
 * `@adc/motion-kit` — публічний API версії 0 (див. API.md).
 *
 * Один вхід для сцен і хоста. Лише для хоста (`apps/remotion`, рендер), не для сцен:
 * ThemeProvider, AssetsProvider, SceneDurationProvider, QaProvider, qaLog, parseQaLog,
 * MusicTrack, Sfx, TemplateScene, templateVariantFor, шрифти (planFont, pruneFontInfo).
 * Що реально імпортують сцени, обмежує AST-guard у codegen.
 * Типи даних реекспортуються з `@adc/shared` без змін.
 */
export type { BrandKit, MotionPersonality, Palette } from "@adc/shared/schemas/brandkit";
export type { Format } from "@adc/shared/schemas/common";
export type { AutoIssueKind, QaLogEntry } from "@adc/shared/schemas/qa";
export type { Scene, ScenePurpose, Storyboard } from "@adc/shared/schemas/storyboard";
export type { AssetRef, AudioManifest, MainProps, ScenePreviewProps, SceneProps, } from "@adc/shared/types/video";
export { averageColor, contrastRatio, isDark, minContrastFor, mix, parseColor, readableOn, relativeLuminance, withAlpha, } from "./color.ts";
export { Breathe, useBeat } from "./devices/motion.tsx";
export { ClipReveal, ColorField, type Side } from "./devices/reveal.tsx";
export { DrawPath, type MorphKey, MorphShape } from "./devices/shape.tsx";
export { type FontInfo, type FontPlan, fontStack, planFont, pruneFontInfo } from "./fonts.ts";
export { FORMAT_SIZE, type FormatInfo, formatFromSize, formatInfoFor, isInsideRect, type Rect, SAFE_MARGINS, SafeArea, sizeForFormat, useFormat, } from "./format.tsx";
export { MusicTrack, musicVolumeAt, Sfx } from "./host/audio.tsx";
export { firstAvailableAsset, TEMPLATE_VARIANTS, TemplateScene, type TemplateVariant, templateVariantFor, } from "./host/TemplateScene.tsx";
export { Backdrop, type BackdropProps } from "./media/Backdrop.tsx";
export { BrandImage, type BrandImageProps, coverScale, type KenBurns, type Mask, UPSCALE_LIMIT, } from "./media/BrandImage.tsx";
export { Logo, type LogoProps } from "./media/Logo.tsx";
export { defaultStagger, type EasingFn, easings, progress, type SpringConfig, springFor, springs, } from "./motion.ts";
export { parseQaLog, QaProvider, qaLog, useQaEnabled } from "./qa.tsx";
export { Body, CTAButton, FitText, Headline, KineticText, Pill, type TextAlign, type TextPreset, } from "./text/components.tsx";
export { type FitResult, fitText, type Measurer, markEmphasis, normalizeWord, splitWords, wrapWords, } from "./text/layout.ts";
export { AssetsProvider, bodyWeight, buildTheme, headingWeight, SceneDurationProvider, type Theme, ThemeProvider, useAssets, useBrand, useTheme, } from "./theme.tsx";
```

## Формат і safe-зона

`src/format`

```ts
import { FORMAT_SIZE, type Format } from "@adc/shared/schemas/common";
import type { CSSProperties, ReactNode } from "react";
export type { Format };
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface FormatInfo {
    format: Format;
    /** 1080 | 1080 | 1920 */
    width: number;
    /** 1920 | 1080 | 1080 */
    height: number;
    /** Зона, де текст і лого гарантовано не перекриваються інтерфейсом соцмереж. */
    safe: Rect;
    isVertical: boolean;
    isLandscape: boolean;
    /** Масштаб відносно короткої сторони 1080 — для розмірів шрифтів і відступів. */
    unit: number;
}
export { FORMAT_SIZE };
/**
 * Відступи safe-зони в частках сторони кадру (top, right, bottom, left).
 * vertical: верх — шапка Reels/TikTok/Shorts, низ — підпис і кнопки, праворуч — рейка лайків
 *   (симетрично з лівим краєм, щоб центрований текст лишався по центру);
 * square: стрічка Instagram/Facebook — рівні поля;
 * landscape: YouTube/плеєри — поля під контроли й заголовок.
 */
export declare const SAFE_MARGINS: Record<Format, {
    top: number;
    right: number;
    bottom: number;
    left: number;
}>;
/** Формат за розмірами кадру (для довільних розмірів — за співвідношенням сторін). */
export declare function formatFromSize(width: number, height: number): Format;
/** Чиста функція за `useFormat()`: формат, розміри, safe-зона. */
export declare function formatInfoFor(width: number, height: number, format?: "vertical" | "square" | "landscape"): FormatInfo;
/** Розміри для формату (`FORMAT_SIZE` з `@adc/shared`). */
export declare function sizeForFormat(format: Format): {
    width: number;
    height: number;
};
export declare function useFormat(): FormatInfo;
/** Чи лежить прямокутник у межах safe-зони (з допуском у px). */
export declare function isInsideRect(inner: Rect, outer: Rect, tolerance?: number): boolean;
/** Контейнер на всю safe-зону; children позиціонуються всередині. */
export declare function SafeArea(props: {
    children: ReactNode;
    padding?: number;
    style?: CSSProperties;
}): import("react").JSX.Element;
```

## Тема, асети, тривалість сцени

`src/theme`

```ts
import type { BrandKit, MotionPersonality } from "@adc/shared/schemas/brandkit";
import type { AssetRef } from "@adc/shared/types/video";
import { type ReactNode } from "react";
import { type FontInfo } from "./fonts.ts";
export interface Theme {
    /** primary, secondary, accent, background, surface, textOnDark, textOnLight */
    palette: BrandKit["palette"];
    /** CSS font-family, вже завантажені. */
    fonts: {
        heading: string;
        body: string;
    };
    weights: {
        heading: number[];
        body: number[];
    };
    /** px для кадру з короткою стороною 1080 (множити на `useFormat().unit`), з visualStyle.shapes. */
    radius: {
        sm: number;
        md: number;
        lg: number;
        pill: number;
    };
    motion: MotionPersonality;
    density: "airy" | "balanced" | "dense";
}
/** Тема з бренд-кіта (чиста функція; ваги — фактично завантажені). */
export declare function buildTheme(brand: BrandKit, weights?: {
    heading: number[];
    body: number[];
}): Theme;
/** Найважча вага заголовків. */
export declare function headingWeight(theme: Theme): number;
/** Вага основного тексту, найближча до 400. */
export declare function bodyWeight(theme: Theme): number;
/**
 * Ставить хост. Завантажує шрифти бренду (`fonts` — метадані Google Fonts від рендера),
 * не малює дітей, доки шрифти не готові (інакше виміри тексту були б з резервного шрифту).
 */
export declare function ThemeProvider(props: {
    brand: BrandKit;
    fonts?: FontInfo[];
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useTheme(): Theme;
/** Бренд-кіт поточного дерева (для Logo і шаблонів). */
export declare function useBrand(): BrandKit;
/** Лише для хоста: асети ревізії для `<BrandImage assetId>` і `<Logo>`. */
export declare function AssetsProvider(props: {
    assets: Record<string, AssetRef>;
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useAssets(): Record<string, AssetRef>;
/** Лише для хоста: тривалість послідовності поточної сцени (для kenBurns/parallax). */
export declare function SceneDurationProvider(props: {
    durationInFrames: number;
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useSceneDuration(fallback: number): number;
```

## Текст: FitText, KineticText, Headline, Body, Pill, CTAButton

`src/text/components`

```ts
import { type CSSProperties } from "react";
import { type TextAlign, type TextPreset } from "./TextBlock.tsx";
export type { TextAlign, TextPreset };
/** Підбирає розмір шрифту, щоб текст вліз у maxLines рядків ширини box; не менше minFontSize. */
export declare function FitText(props: {
    text: string;
    /** Дефолт 2. */
    maxLines?: number;
    maxFontSize: number;
    /** Якщо не вліз і на мінімумі — QA-лог text_min_size / text_overflow. */
    minFontSize: number;
    /** px, дефолт — ширина safe-зони. */
    width?: number;
    font?: "heading" | "body";
    weight?: number;
    color?: string;
    align?: TextAlign;
    style?: CSSProperties;
}): import("react").JSX.Element;
/** Кінетичний текст: поява по словах або рядках. */
export declare function KineticText(props: {
    text: string;
    preset: TextPreset;
    /** Дефолт "word". */
    by?: "word" | "line";
    startFrame?: number;
    /** Кадрів між елементами; дефолт залежить від theme.motion. */
    stagger?: number;
    /** Слова з акцентом (колір accent). */
    emphasis?: string[];
    /** Дефолт 3. */
    maxLines?: number;
    maxFontSize: number;
    minFontSize: number;
    width?: number;
    font?: "heading" | "body";
    color?: string;
    align?: TextAlign;
    style?: CSSProperties;
}): import("react").JSX.Element;
/** Заголовок сцени: FitText/KineticText з токенами теми (font heading, вага max). */
export declare function Headline(props: {
    text: string;
    emphasis?: string[];
    /** Без preset — статичний. */
    preset?: TextPreset;
    startFrame?: number;
    /** Дефолт 3. */
    maxLines?: number;
    /** Дефолт "l". */
    size?: "m" | "l" | "xl";
    color?: string;
    align?: TextAlign;
    width?: number;
    style?: CSSProperties;
}): import("react").JSX.Element;
/** Підзаголовок / основний текст (font body). */
export declare function Body(props: {
    text: string;
    preset?: TextPreset;
    startFrame?: number;
    /** Дефолт 3. */
    maxLines?: number;
    /** Дефолт "m". */
    size?: "s" | "m" | "l";
    color?: string;
    align?: TextAlign;
    width?: number;
    emphasis?: string[];
    style?: CSSProperties;
}): import("react").JSX.Element;
/** Плашка: ціна, знижка, бейдж. */
export declare function Pill(props: {
    text: string;
    startFrame?: number;
    variant?: "accent" | "primary" | "surface";
    size?: "s" | "m" | "l";
    style?: CSSProperties;
}): import("react").JSX.Element;
/** Кнопка CTA з м'якою пульсацією. */
export declare function CTAButton(props: {
    text: string;
    startFrame?: number;
    variant?: "accent" | "primary";
    size?: "m" | "l";
    style?: CSSProperties;
}): import("react").JSX.Element;
```

## Текст: пресети анімації

`src/text/TextBlock`

```ts
import { type CSSProperties } from "react";
export type TextPreset = "rise" | "fade" | "scale" | "highlight" | "typewriter";
export type TextAlign = "left" | "center" | "right";
export interface TextBlockProps {
    text: string;
    maxLines: number;
    maxFontSize: number;
    minFontSize: number;
    width?: number;
    font?: "heading" | "body";
    weight?: number;
    color?: string;
    align?: TextAlign;
    style?: CSSProperties;
    emphasis?: string[];
    /** Без preset — статичний текст. */
    preset?: TextPreset;
    by?: "word" | "line";
    startFrame?: number;
    stagger?: number;
    /** Назва компонента для QA-логів. */
    component: string;
}
/** Внутрішній блок тексту: підбір розміру, перенос, emphasis, кінетика, QA. */
export declare function TextBlock(props: TextBlockProps): import("react").JSX.Element;
```

## Зображення

`src/media/BrandImage`

```ts
import type { AssetRef } from "@adc/shared/types/video";
import { type CSSProperties } from "react";
export interface Mask {
    type: "rounded" | "circle" | "blob" | "diagonal";
}
export interface KenBurns {
    /** Масштаб 1.0–1.25. */
    from: number;
    to: number;
    direction?: "in" | "out" | "left" | "right" | "up" | "down";
}
export interface BrandImageProps {
    /** Ключ з props.assets; невідомий id → нейтральний фон + QA-лог. */
    assetId: string;
    /** Дефолт "cover". */
    fit?: "cover" | "contain";
    /** Дефолт — AssetRef.focal. */
    focal?: {
        x: number;
        y: number;
    };
    kenBurns?: KenBurns;
    /** px зсуву за сцену. */
    parallax?: number;
    mask?: Mask;
    radius?: number;
    /** Затемнення під текст. */
    overlay?: {
        color: string;
        opacity: number;
    };
    startFrame?: number;
    /** Розмір і позиція контейнера (дефолт — на весь батьківський блок). */
    style?: CSSProperties;
}
/** Збільшення, після якого фото помітно мило. */
export declare const UPSCALE_LIMIT = 2;
/** Масштаб, з яким фото заповнює контейнер (без Ken Burns). */
export declare function coverScale(asset: Pick<AssetRef, "width" | "height">, box: {
    width: number;
    height: number;
}, fit: "cover" | "contain"): number;
/** Фото з асетів ревізії: кроп за фокусом, Ken Burns, паралакс, маски. */
export declare function BrandImage(props: BrandImageProps): import("react").JSX.Element;
```

## Лого

`src/media/Logo`

```ts
import { type CSSProperties } from "react";
export interface LogoProps {
    /** Висота, px (дефолт 120 × unit). */
    size?: number;
    /** Фон, на якому стоїть лого; підкладка — якщо brand.logo.needsBackground. */
    variant?: "auto" | "onDark" | "onLight";
    startFrame?: number;
    style?: CSSProperties;
}
/** Лого бренду; без зображення — brand.logo.textFallback шрифтом heading. */
export declare function Logo(props: LogoProps): import("react").JSX.Element;
```

## Фон

`src/media/Backdrop`

```ts
export interface BackdropProps {
    variant: "solid" | "gradient" | "noise" | "shapes";
    /** Дефолт palette.background. */
    color?: string;
    /** Для gradient/shapes. */
    colors?: string[];
    /** Для gradient, градуси. */
    angle?: number;
    /** Повільний дрейф (функція від кадру). */
    animate?: boolean;
}
/** Фон сцени. */
export declare function Backdrop(props: BackdropProps): import("react").JSX.Element;
```

## Рух: springs, easings, progress

`src/motion`

```ts
import type { MotionPersonality } from "@adc/shared/schemas/brandkit";
import { type SpringConfig } from "remotion";
export type { SpringConfig };
export type EasingFn = (t: number) => number;
/** Пресети spring() для remotion: `spring({ frame, fps, config: springs.soft })`. */
export declare const springs: {
    snappy: SpringConfig;
    soft: SpringConfig;
    premium: SpringConfig;
};
/** Easing-функції для `interpolate(..., { easing })`. */
export declare const easings: {
    out: EasingFn;
    inOut: EasingFn;
    expoOut: EasingFn;
    backOut: EasingFn;
};
/** Хелпер: 0→1 від startFrame за duration кадрів з easing (clamp). */
export declare function progress(frame: number, startFrame: number, duration: number, easing?: EasingFn): number;
/** Пружина за характером руху бренду. */
export declare function springFor(motion: MotionPersonality): SpringConfig;
/** Кадрів між елементами кінетичного тексту за характером руху. */
export declare function defaultStagger(motion: MotionPersonality, by: "word" | "line"): number;
```

## Кольори і контраст

`src/color`

```ts
/**
 * Робота з кольорами: розбір, змішування, відносна яскравість і контраст за WCAG 2.x.
 * Чисті функції — працюють і в браузері, і в Node (тести, QA).
 */
export interface Rgb {
    r: number;
    g: number;
    b: number;
    /** 0..1 */
    a: number;
}
/** Розбирає `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(…)`, `rgba(…)`. Невідомий формат → null. */
export declare function parseColor(input: string): Rgb | null;
export declare function toHex({ r, g, b }: Pick<Rgb, "r" | "g" | "b">): string;
/** Колір із прозорістю у форматі `rgba(…)`. */
export declare function withAlpha(color: string, alpha: number): string;
/** Лінійне змішування: t = 0 → a, t = 1 → b. */
export declare function mix(a: string, b: string, t: number): string;
/** Середній колір списку (для градієнтів — оцінка фону під текстом). */
export declare function averageColor(colors: readonly string[]): string;
/** Відносна яскравість WCAG (0 — чорний, 1 — білий). */
export declare function relativeLuminance(color: string): number;
/** Контраст WCAG між двома кольорами: 1..21. */
export declare function contrastRatio(a: string, b: string): number;
export declare function isDark(color: string): boolean;
/** Мінімальний контраст тексту: великий текст (≥ 36 px у кадрі 1080) — 3:1, інший — 4.5:1. */
export declare function minContrastFor(fontSizePx: number): number;
/**
 * Колір тексту з достатнім контрастом для фону: обирає контрастніший з
 * `palette.textOnDark` / `palette.textOnLight` (без палітри — білий / майже чорний).
 */
export declare function readableOn(background: string, palette?: {
    textOnDark: string;
    textOnLight: string;
}): string;
```

## QA-режим (лише хост)

`src/qa`

```ts
import { type AutoIssueKind, type QaLogEntry } from "@adc/shared/schemas/qa";
import { type ReactNode, type RefObject } from "react";
/**
 * QA-режим: компоненти перевіряють себе після рендеру кадру і пишуть у консоль браузера
 * `ADC_QA {json}` (QaLogEntry). Стадія `check` збирає ці рядки через `onBrowserLog`.
 */
export type { QaLogEntry };
/** Пише рядок `ADC_QA {json}` у console. */
export declare function qaLog(entry: QaLogEntry): void;
/** Розбирає рядок логу браузера; не QA-рядок → null. */
export declare function parseQaLog(text: string): QaLogEntry | null;
/** Атрибут, яким компоненти позначають свій фон для перевірки контрасту ("image" — невідомий). */
export declare const BG_ATTR = "data-adc-bg";
/** Вмикає QA-режим для дерева: компоненти пишуть ADC_QA-логи. */
export declare function QaProvider(props: {
    enabled: boolean;
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useQaEnabled(): boolean;
/** Фон під точкою: перший непрозорий шар під елементом. null — невідомо (фото без затемнення). */
export declare function backgroundAt(el: HTMLElement, x: number, y: number): string | null;
export interface QaCheckOptions {
    component: string;
    /** Перевірити, що елемент у safe-зоні. */
    safeArea?: boolean;
    /** Перевірити контраст (колір тексту — computed color елемента). */
    contrast?: boolean;
    /** Додаткові перевірки компонента (переповнення тексту, масштаб фото…). */
    extra?: (el: HTMLElement, report: (kind: AutoIssueKind, detail: string, value?: number | null) => void) => void;
}
/**
 * Хук QA-перевірок елемента. Працює лише в QA-режимі, у `useLayoutEffect` після кожного кадру;
 * однаковий запис логується один раз на монтування компонента.
 */
export declare function useQaCheck(ref: RefObject<HTMLElement | null>, options: QaCheckOptions): void;
```

## TemplateScene (лише хост)

`src/host/TemplateScene`

```ts
import type { ScenePurpose } from "@adc/shared/schemas/storyboard";
import type { SceneProps } from "@adc/shared/types/video";
export type TemplateVariant = "hero" | "text" | "image" | "cta";
export declare const TEMPLATE_VARIANTS: readonly TemplateVariant[];
/** Детермінований вибір шаблону за scene.purpose. */
export declare function templateVariantFor(purpose: ScenePurpose): TemplateVariant;
/** Перший асет сцени, що є в props.assets (або null). */
export declare function firstAvailableAsset(props: Pick<SceneProps, "scene" | "assets">): string | null;
/** Лише для хоста: детерміновані шаблони hero | text | image | cta; вибір за scene.purpose. */
export declare function TemplateScene(props: SceneProps & {
    variant?: TemplateVariant;
}): import("react").JSX.Element;
```

## Звук (лише хост)

`src/host/audio`

```ts
import type { AudioManifest } from "@adc/shared/types/video";
/** Гучність музики з fade-out наприкінці ролика (чиста функція від кадру). */
export declare function musicVolumeAt(frame: number, totalFrames: number, fadeOutFrames: number, volume: number): number;
/** Лише для хоста: музика ролика з fade-out наприкінці; довший трек підрізається. */
export declare function MusicTrack(props: {
    audio: AudioManifest;
    totalFrames: number;
}): import("react").JSX.Element | null;
/** Лише для хоста: SFX за cue з бібліотеки ревізії, з кадру `from` (глобального). */
export declare function Sfx(props: {
    cue: string;
    audio: AudioManifest;
    from: number;
}): import("react").JSX.Element | null;
```

## Шрифти (лише хост)

`src/fonts`

```ts
import type { FontInfo } from "@remotion/google-fonts/base";
/**
 * Шрифти бренду з Google Fonts.
 *
 * Метадані шрифту (`FontInfo`, лише URL-и файлів) резолвить рендер на боці Node і передає в
 * inputProps — так у бандл не потрапляють ~1800 модулів `@remotion/google-fonts`.
 * У браузері `loadFontFromInfo` реєструє `@font-face` і чекає файли (`delayRender` усередині).
 */
export type { FontInfo };
/** Потрібні підмножини: українська й англійська. */
export declare const FONT_SUBSETS: readonly ["latin", "cyrillic"];
export declare const FALLBACK_STACK = "system-ui, -apple-system, \"Segoe UI\", Roboto, Arial, sans-serif";
/** CSS font-family з резервним стеком. */
export declare function fontStack(family: string): string;
/** Найближча доступна вага (для 700 при наявних 600/800 — 600, при рівності — важча). */
export declare function nearestWeight(wanted: number, available: readonly number[]): number;
export interface FontPlan {
    family: string;
    /** Фактичні ваги, які буде завантажено (≤ запитаних, дедуплікація). */
    weights: number[];
    subsets: string[];
    /** null — шрифту немає серед переданих метаданих (рендеримо резервним стеком). */
    info: FontInfo | null;
}
/** Ваги і підмножини, які реально є в шрифті. */
export declare function planFont(family: string, wanted: readonly number[], infos: readonly FontInfo[]): FontPlan;
/**
 * Обрізає FontInfo до стилю normal, потрібних ваг і підмножин latin+cyrillic —
 * щоб inputProps лишались компактними.
 */
export declare function pruneFontInfo(info: FontInfo, wanted: readonly number[]): FontInfo;
/** Завантажує шрифт у документ; повертає промис готовності. */
export declare function loadPlannedFont(plan: FontPlan): Promise<void>;
```

## Розкладка тексту (чисті функції)

`src/text/layout`

```ts
/**
 * Розкладка тексту без DOM: розбиття на слова, перенос по ширині, підбір розміру шрифту.
 * Ширини слів дає `Measurer` (у браузері — `measureText` з `@remotion/layout-utils`,
 * у тестах — фейковий вимірювач), тому логіка детермінована й тестується в Node.
 */
/** Ширина тексту в px для розміру шрифту `fontSize`. */
export type Measurer = (text: string, fontSize: number) => number;
/** Запас ширини: браузер переносить трохи інакше, ніж сума ширин слів. */
export declare const WIDTH_SAFETY = 0.97;
export declare function splitWords(text: string): string[];
/** Жадібний перенос слів у рядки шириною ≤ maxWidth. Слово, ширше за рядок, займає рядок саме. */
export declare function wrapWords(words: readonly string[], maxWidth: number, fontSize: number, measure: Measurer): string[][];
export interface FitInput {
    text: string;
    maxLines: number;
    width: number;
    maxFontSize: number;
    minFontSize: number;
    measure: Measurer;
}
export interface FitResult {
    /** Розмір, яким малюємо (між minFontSize і maxFontSize). */
    fontSize: number;
    /** Слова по рядках для цього розміру. */
    lines: string[][];
    /** Найбільший розмір, з яким текст влазить (може бути < minFontSize). */
    idealFontSize: number;
    /** Довелося обмежити розмір мінімумом. */
    hitMin: boolean;
    /** Навіть на мінімумі текст не влазить у maxLines рядків / ширину. */
    overflow: boolean;
    /** Ширина найдовшого рядка, px. */
    widestLine: number;
}
/** Найбільший розмір шрифту ≤ maxFontSize, з яким текст влазить у maxLines рядків ширини width. */
export declare function fitText(input: FitInput): FitResult;
export interface SingleLineFitInput {
    text: string;
    /** Доступна ширина всього боксу, px. */
    width: number;
    maxFontSize: number;
    minFontSize: number;
    /** Сумарний горизонтальний padding боксу в em. */
    paddingEm: number;
    measure: Measurer;
}
export interface SingleLineFitResult {
    fontSize: number;
    /** Розмір менший за maxFontSize. */
    shrunk: boolean;
    /** Не влазить навіть на minFontSize (fontSize = minFontSize). */
    overflow: boolean;
}
/**
 * Найбільший розмір ≤ maxFontSize, з яким текст в один рядок разом із padding влазить у width:
 * measure(text, f) + paddingEm × f ≤ width. Ширина лінійна по f, тож розмір рахується замкнуто.
 */
export declare function fitSingleLine(input: SingleLineFitInput): SingleLineFitResult;
/** Нормалізація слова для порівняння з emphasis: регістр і пунктуація по краях. */
export declare function normalizeWord(word: string): string;
/**
 * Позначає слова, що входять у фрази emphasis (фраза з кількох слів — послідовність).
 * Повертає масив прапорців паралельно `words`.
 */
export declare function markEmphasis(words: readonly string[], emphasis: readonly string[] | undefined): boolean[];
/** Приблизний вимірювач для Node/тестів: середня ширина символу 0.56 em, пробіл 0.28 em. */
export declare const approxMeasurer: Measurer;
```

## Вимірювання тексту (внутрішнє)

`src/text/measure`

```ts
import { type Measurer } from "./layout.ts";
/**
 * Вимірювач на основі `measureText` (DOM). Слова міряються один раз на опорному розмірі
 * (кеш усередині layout-utils), тож бінарний пошук розміру шрифту дешевий.
 * Поза браузером — приблизний вимірювач.
 */
export declare function createMeasurer(fontFamily: string, fontWeight: number, letterSpacingEm?: number): Measurer;
```

## devices/motion

`src/devices/motion`

```ts
import type { CSSProperties, ReactNode } from "react";
import { type EasingFn, type SpringConfig } from "../motion.ts";
/** 0→1 від кадру `at`: пружина бренду або progress за `duration` (clamp). */
export declare function useBeat(at: number, opts?: {
    duration?: number;
    easing?: EasingFn;
    config?: SpringConfig;
}): number;
/** Шар на весь кадр, що «дихає» з `startFrame` (масштаб і зсув по косинусу). */
export declare function Breathe(props: {
    startFrame?: number;
    period?: number;
    amount?: number;
    drift?: number;
    style?: CSSProperties;
    children?: ReactNode;
}): import("react").JSX.Element;
```

## devices/reveal

`src/devices/reveal`

```ts
import type { Palette } from "@adc/shared/schemas/brandkit";
import type { CSSProperties, ReactNode } from "react";
import { type EasingFn } from "../motion.ts";
export type Side = "left" | "right" | "top" | "bottom";
/** Поле кольору палітри: wipe / split / push кадру. */
export declare function ColorField(props: {
    mode?: "wipe" | "split" | "push";
    color?: keyof Palette;
    from?: Side;
    startFrame?: number;
    duration?: number;
    /** 0–1. */
    cover?: number;
    exitFrame?: number;
    easing?: EasingFn;
    children?: ReactNode;
}): import("react").JSX.Element;
/** Відкриває дітей через clip-path. */
export declare function ClipReveal(props: {
    shape?: "inset" | "circle" | "polygon";
    from?: Side | "center";
    startFrame?: number;
    duration?: number;
    easing?: EasingFn;
    style?: CSSProperties;
    children?: ReactNode;
}): import("react").JSX.Element;
```

## devices/shape

`src/devices/shape`

```ts
import type { Palette } from "@adc/shared/schemas/brandkit";
import { type CSSProperties, type ReactNode } from "react";
import { type EasingFn } from "../motion.ts";
/** SVG-лінія, що малюється (evolvePath). */
export declare function DrawPath(props: {
    d: string;
    width: number;
    height: number;
    viewBox?: string;
    color?: keyof Palette;
    strokeWidth?: number;
    startFrame?: number;
    duration?: number;
    easing?: EasingFn;
    /** Може виходити за safe-зону (без QA-перевірки). */
    bleed?: boolean;
    style?: CSSProperties;
}): import("react").JSX.Element;
/** Ключовий стан MorphShape, px. */
export interface MorphKey {
    /** Старт переходу в цей стан; дефолт — старт попереднього + duration. */
    at?: number;
    x: number;
    y: number;
    width: number;
    height: number;
    radius?: number;
    color?: keyof Palette;
}
/** Заокруглена форма між ключовими станами. */
export declare function MorphShape(props: {
    keys: MorphKey[];
    duration?: number;
    easing?: EasingFn;
    /** Може виходити за safe-зону (без QA-перевірки). */
    bleed?: boolean;
    style?: CSSProperties;
    children?: ReactNode;
}): import("react").JSX.Element;
```
