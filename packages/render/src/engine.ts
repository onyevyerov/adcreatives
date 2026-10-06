import type { MainInput, ScenePreviewInput } from "@adc/remotion/host-props";
import type {
  BrowserLog,
  BundleJobOptions,
  RenderEngine,
  RenderMediaOptions,
  RenderStillOptions,
} from "@adc/shared/render/RenderEngine";
import type { BrandKit } from "@adc/shared/schemas/brandkit";
import {
  type ChromiumOptions,
  type HeadlessBrowser,
  makeCancelSignal,
  openBrowser,
  type BrowserLog as RemotionBrowserLog,
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { bundleJobDir } from "./bundle.ts";
import { resolveBrandFonts } from "./fonts.ts";

export interface RemotionEngineOptions {
  /** rspack-бандлер (дефолт true); false — webpack. */
  rspack?: boolean;
  /** Кеш бандлера (дефолт true). */
  enableCaching?: boolean;
  /** Паралельність renderMedia (дефолт — Remotion: половина ядер). */
  concurrency?: number | null;
  /** Ключ Company License; дефолт — env REMOTION_LICENSE_KEY. */
  licenseKey?: string | null;
  logLevel?: "error" | "warn" | "info" | "verbose";
  /**
   * Шлях до Chrome Headless Shell; дефолт — env REMOTION_BROWSER_EXECUTABLE, інакше Remotion
   * шукає/завантажує браузер у node_modules/.remotion найближчого до cwd package.json.
   */
  browserExecutable?: string | null;
  /** Прогрес бандла, %. */
  onBundleProgress?: (percent: number) => void;
}

/** Помилка рендера з логами браузера, зібраними до збою (для прив'язки runtime-помилки до сцени). */
export class RenderError extends Error {
  override name = "RenderError";
  constructor(
    message: string,
    readonly logs: BrowserLog[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const LOG_TYPES = new Set<BrowserLog["type"]>(["log", "info", "warn", "error", "debug", "verbose", "trace"]);

function toBrowserLog(log: RemotionBrowserLog, frame?: number): BrowserLog {
  const raw = log.type === "warning" ? "warn" : log.type;
  const type = LOG_TYPES.has(raw as BrowserLog["type"]) ? (raw as BrowserLog["type"]) : "log";
  return frame === undefined ? { type, text: log.text } : { type, text: log.text, frame };
}

function cancelFrom(signal: AbortSignal | undefined) {
  const { cancelSignal, cancel } = makeCancelSignal();
  if (signal) {
    signal.throwIfAborted();
    signal.addEventListener("abort", cancel, { once: true });
  }
  return cancelSignal;
}

/** Реалізація `RenderEngine` на Remotion. Браузер відкривається ліниво і переюзується. */
export class RemotionRenderEngine implements RenderEngine {
  private browser: Promise<HeadlessBrowser> | null = null;
  private readonly chromiumOptions: ChromiumOptions = { enableMultiProcessOnLinux: true };
  private readonly fontCache = new WeakMap<BrandKit, Promise<MainInput["fonts"]>>();

  constructor(private readonly options: RemotionEngineOptions = {}) {}

  private getBrowser(): Promise<HeadlessBrowser> {
    if (!this.browser) {
      const browserExecutable =
        this.options.browserExecutable ?? process.env.REMOTION_BROWSER_EXECUTABLE ?? null;
      this.browser = openBrowser("chrome", {
        chromiumOptions: this.chromiumOptions,
        browserExecutable: browserExecutable || null,
        logLevel: this.options.logLevel ?? "error",
      });
      this.browser.catch(() => {
        this.browser = null;
      });
    }
    return this.browser;
  }

  private fontsFor(brand: BrandKit): Promise<MainInput["fonts"]> {
    let p = this.fontCache.get(brand);
    if (!p) {
      p = resolveBrandFonts(brand);
      this.fontCache.set(brand, p);
    }
    return p;
  }

  async bundleJob(opts: BundleJobOptions): Promise<{ serveUrl: string }> {
    return bundleJobDir({
      jobDir: opts.jobDir,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(this.options.rspack !== undefined ? { rspack: this.options.rspack } : {}),
      ...(this.options.enableCaching !== undefined ? { enableCaching: this.options.enableCaching } : {}),
      ...(this.options.onBundleProgress ? { onProgress: this.options.onBundleProgress } : {}),
    });
  }

  async renderStill(opts: RenderStillOptions): Promise<{ logs: BrowserLog[] }> {
    const logs: BrowserLog[] = [];
    const cancelSignal = cancelFrom(opts.signal);
    const base = { ...opts.inputProps, format: opts.format };
    const inputProps: MainInput | ScenePreviewInput = { ...base, fonts: await this.fontsFor(base.brand) };
    const puppeteerInstance = await this.getBrowser();
    const logLevel = this.options.logLevel ?? "error";
    try {
      const composition = await selectComposition({
        serveUrl: opts.serveUrl,
        id: opts.composition,
        inputProps,
        puppeteerInstance,
        chromiumOptions: this.chromiumOptions,
        logLevel,
        onBrowserLog: (log) => logs.push(toBrowserLog(log)),
      });
      await renderStill({
        composition,
        serveUrl: opts.serveUrl,
        output: opts.out,
        frame: opts.frame,
        inputProps,
        imageFormat: "png",
        overwrite: true,
        puppeteerInstance,
        chromiumOptions: this.chromiumOptions,
        logLevel,
        cancelSignal,
        onBrowserLog: (log) => logs.push(toBrowserLog(log, opts.frame)),
      });
    } catch (err) {
      throw new RenderError(err instanceof Error ? err.message : String(err), logs, { cause: err });
    }
    return { logs };
  }

  /** `durationMs` — тривалість рендера (wall clock), для статистики часу. */
  async renderMedia(opts: RenderMediaOptions): Promise<{ durationMs: number }> {
    const started = Date.now();
    const cancelSignal = cancelFrom(opts.signal);
    const base = { ...opts.inputProps, format: opts.format };
    const inputProps: MainInput = { ...base, fonts: await this.fontsFor(base.brand) };
    const puppeteerInstance = await this.getBrowser();
    const logLevel = this.options.logLevel ?? "error";
    const composition = await selectComposition({
      serveUrl: opts.serveUrl,
      id: "Main",
      inputProps,
      puppeteerInstance,
      chromiumOptions: this.chromiumOptions,
      logLevel,
    });
    const licenseKey = this.options.licenseKey ?? process.env.REMOTION_LICENSE_KEY ?? null;
    await renderMedia({
      composition,
      serveUrl: opts.serveUrl,
      outputLocation: opts.out,
      inputProps,
      codec: "h264",
      audioCodec: "aac",
      crf: 18,
      x264Preset: "veryfast",
      overwrite: true,
      puppeteerInstance,
      chromiumOptions: this.chromiumOptions,
      logLevel,
      cancelSignal,
      ...(this.options.concurrency != null ? { concurrency: this.options.concurrency } : {}),
      licenseKey: licenseKey || null,
      onProgress: ({ progress }) => opts.onProgress?.(progress),
    });
    return { durationMs: Date.now() - started };
  }

  async close(): Promise<void> {
    const pending = this.browser;
    this.browser = null;
    if (!pending) return;
    try {
      const browser = await pending;
      await browser.close({ silent: true });
    } catch {
      // браузер уже закритий або не відкрився
    }
  }
}

export function createRenderEngine(options?: RemotionEngineOptions): RenderEngine {
  return new RemotionRenderEngine(options);
}
