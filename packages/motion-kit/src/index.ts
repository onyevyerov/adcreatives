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
export type {
  AssetRef,
  AudioManifest,
  MainProps,
  ScenePreviewProps,
  SceneProps,
} from "@adc/shared/types/video";
export {
  averageColor,
  contrastRatio,
  isDark,
  minContrastFor,
  mix,
  parseColor,
  readableOn,
  relativeLuminance,
  withAlpha,
} from "./color.ts";
export { type FontInfo, type FontPlan, fontStack, planFont, pruneFontInfo } from "./fonts.ts";
export {
  FORMAT_SIZE,
  type FormatInfo,
  formatFromSize,
  formatInfoFor,
  isInsideRect,
  type Rect,
  SAFE_MARGINS,
  SafeArea,
  sizeForFormat,
  useFormat,
} from "./format.tsx";
export { MusicTrack, musicVolumeAt, Sfx } from "./host/audio.tsx";
export {
  firstAvailableAsset,
  TEMPLATE_VARIANTS,
  TemplateScene,
  type TemplateVariant,
  templateVariantFor,
} from "./host/TemplateScene.tsx";
export { Backdrop, type BackdropProps } from "./media/Backdrop.tsx";
export {
  BrandImage,
  type BrandImageProps,
  coverScale,
  type KenBurns,
  type Mask,
  UPSCALE_LIMIT,
} from "./media/BrandImage.tsx";
export { Logo, type LogoProps } from "./media/Logo.tsx";
export {
  defaultStagger,
  type EasingFn,
  easings,
  progress,
  type SpringConfig,
  springFor,
  springs,
} from "./motion.ts";
export { parseQaLog, QaProvider, qaLog, useQaEnabled } from "./qa.tsx";
export {
  Body,
  CTAButton,
  FitText,
  Headline,
  KineticText,
  Pill,
  type TextAlign,
  type TextPreset,
} from "./text/components.tsx";
export {
  type FitResult,
  fitText,
  type Measurer,
  markEmphasis,
  normalizeWord,
  splitWords,
  wrapWords,
} from "./text/layout.ts";
export {
  AssetsProvider,
  bodyWeight,
  buildTheme,
  headingWeight,
  SceneDurationProvider,
  type Theme,
  ThemeProvider,
  useAssets,
  useBrand,
  useTheme,
} from "./theme.tsx";
