import type { Format } from "../schemas/common.ts";
import type { CompositionId, MainProps, ScenePreviewProps } from "../types/video.ts";

/** Рядок логу браузера під час рендеру (сюди потрапляють `ADC_QA {…}` і runtime-помилки). */
export interface BrowserLog {
  type: "log" | "info" | "warn" | "error" | "debug" | "verbose" | "trace";
  text: string;
  /** Кадр, на якому з'явився лог (якщо відомо). */
  frame?: number;
}

export interface BundleJobOptions {
  /** Тека ревізії з відео: `rev/<n>/video` (абсолютний шлях) — сцени, public/, bundle/. */
  jobDir: string;
  signal?: AbortSignal;
}

export type StillInput =
  | { composition: "Main"; inputProps: MainProps }
  | { composition: "ScenePreview"; inputProps: ScenePreviewProps };

export type RenderStillOptions = StillInput & {
  serveUrl: string;
  /** Кадр у межах композиції. */
  frame: number;
  format: Format;
  /** Абсолютний шлях PNG. */
  out: string;
  signal?: AbortSignal;
};

export interface RenderMediaOptions {
  serveUrl: string;
  inputProps: MainProps;
  format: Format;
  /** Абсолютний шлях MP4. */
  out: string;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

/**
 * Рендер Remotion (реалізація — B3, `packages/render`). Браузер відкривається раз
 * і переюзується в межах задачі; `close()` звільняє його.
 */
export interface RenderEngine {
  bundleJob(opts: BundleJobOptions): Promise<{ serveUrl: string }>;
  renderStill(opts: RenderStillOptions): Promise<{ logs: BrowserLog[] }>;
  /** `durationMs` — машинний час рендеру (wall clock), не тривалість відео. */
  renderMedia(opts: RenderMediaOptions): Promise<{ durationMs: number }>;
  close(): Promise<void>;
}

export type { CompositionId };
