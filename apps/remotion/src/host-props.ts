import type { FontInfo } from "@adc/motion-kit";
import type { MainProps, ScenePreviewProps } from "@adc/shared/types/video";

/**
 * Пропси композицій хоста. До контрактних `MainProps` / `ScenePreviewProps` рендер
 * (`@adc/render`) додає `fonts` — метадані Google Fonts бренду, обрізані до потрібних ваг
 * і підмножин (резолвляться в Node, щоб не тягнути в бандл увесь `@remotion/google-fonts`).
 *
 * Mapped-типи замість інтерфейсів — бо Remotion вимагає `Record<string, unknown>`.
 */
export interface HostExtras {
  fonts?: FontInfo[];
}

type Plain<T> = { [K in keyof T]: T[K] };

export type MainInput = Plain<MainProps & HostExtras>;
export type ScenePreviewInput = Plain<ScenePreviewProps & HostExtras>;

/** Аліас модуля сцен задачі: `rev/<n>/video/scenes/index.ts` (налаштовує bundleJob). */
export const JOB_SCENES_ALIAS = "@job/scenes";
