import { z } from "zod";
import type { BrandKit, FontFile } from "../schemas/brandkit.ts";
import { Focal, type Format } from "../schemas/common.ts";
import type { Scene, Storyboard } from "../schemas/storyboard.ts";

/**
 * Контракт між хостом Remotion (B3), сценами з codegen (B4), аудіо (B5) і рендером (B8).
 * Усі шляхи до медіа — відносно `rev/<n>/video/public/` і передаються в `staticFile()`.
 */

/** Зображення для `<BrandImage assetId>`. */
export const AssetRef = z.object({
  /** Шлях відносно public/ (для staticFile). */
  src: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  focal: Focal,
});
export type AssetRef = z.infer<typeof AssetRef>;

/** `rev/<n>/audio.json`. Розміщення SFX на таймлайні робить хост за `scene.sfxCue`. */
export const AudioManifest = z.object({
  music: z
    .object({
      src: z.string(),
      durationMs: z.number().int(),
      /** Fade-out наприкінці ролика. */
      fadeOutMs: z.number().int(),
      /** 0..1 */
      volume: z.number().min(0).max(1),
      planHash: z.string(),
    })
    .nullable(),
  /**
   * Готове зведення (музика, події, дакінг, мастер). Якщо не null, хост грає лише його
   * і ігнорує `music` та `sfx`.
   */
  mix: z
    .object({
      src: z.string(),
      durationMs: z.number().int(),
      /** Мастер: інтегральна гучність, true peak і підсилення; null — старі зведення. */
      integratedLufs: z.number().nullable().default(null),
      truePeakDbtp: z.number().nullable().default(null),
      masterGainDb: z.number().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Бібліотека SFX ревізії: cue → файл. */
  sfx: z.array(
    z.object({
      cue: z.string(),
      src: z.string(),
      durationMs: z.number().int(),
      volume: z.number().min(0).max(1),
    }),
  ),
  /** Тривалість відео, під яку зібрано маніфест. */
  totalFrames: z.number().int(),
});
export type AudioManifest = z.infer<typeof AudioManifest>;

/** Локальний шрифт сайту для хоста: файл у `public/` ревізії, завантажується `@remotion/fonts`. */
export interface LocalFont {
  family: string;
  weight: number;
  format: FontFile["format"];
  /** Шлях у public/: fonts/<file>. */
  src: string;
}

/** Пропси сцени, згенерованої codegen: `export default function Scene(props: SceneProps)`. */
export interface SceneProps {
  scene: Scene;
  brand: BrandKit;
  assets: Record<string, AssetRef>;
  durationInFrames: number;
}

/** Пропси композиції `Main`. */
export interface MainProps {
  brand: BrandKit;
  storyboard: Storyboard;
  format: Format;
  assets: Record<string, AssetRef>;
  audio: AudioManifest;
  /** Сцени, які замість коду codegen малюються `TemplateScene`. */
  templateScenes: string[];
  /** QA-режим: компоненти пишуть `ADC_QA`-логи. */
  qa?: boolean;
}

/** Пропси композиції `ScenePreview`: одна сцена без переходів і звуку. */
export interface ScenePreviewProps {
  brand: BrandKit;
  storyboard: Storyboard;
  sceneId: string;
  format: Format;
  assets: Record<string, AssetRef>;
  /** Малювати TemplateScene замість коду сцени. */
  useTemplate: boolean;
  qa?: boolean;
}

export const COMPOSITION_IDS = ["Main", "ScenePreview"] as const;
export type CompositionId = (typeof COMPOSITION_IDS)[number];
