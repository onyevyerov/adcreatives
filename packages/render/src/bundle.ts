import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { JOB_SCENES_ALIAS } from "@adc/remotion/host-props";
import { type BundlerOverrideFn, bundle } from "@remotion/bundler";

const require = createRequire(import.meta.url);

/** Тека застосунку `apps/remotion` (через резолв пакета, щоб працювало і в Docker). */
export const REMOTION_APP_DIR = path.dirname(require.resolve("@adc/remotion/package.json"));
export const REMOTION_ENTRY = path.join(REMOTION_APP_DIR, "src", "index.ts");

export interface JobPaths {
  jobDir: string;
  scenesIndex: string;
  publicDir: string;
  bundleDir: string;
}

export function jobPaths(jobDir: string): JobPaths {
  const abs = path.resolve(jobDir);
  return {
    jobDir: abs,
    scenesIndex: path.join(abs, "scenes", "index.ts"),
    publicDir: path.join(abs, "public"),
    bundleDir: path.join(abs, "bundle"),
  };
}

/**
 * Оверрайд конфігу (webpack і rspack однаково):
 * - `@job/scenes` → `scenes/index.ts` задачі;
 * - сцени лежать поза монорепо (DATA_DIR), тож їхні імпорти (`react`, `remotion`,
 *   `@adc/motion-kit`, `@remotion/*`) резолвляться з node_modules хоста як запасний шлях.
 */
export function jobOverride(scenesIndex: string): BundlerOverrideFn {
  return (config) => {
    const resolve = config.resolve ?? {};
    const alias = (resolve.alias ?? {}) as Record<string, string | false | string[]>;
    const modules = (resolve.modules as string[] | undefined) ?? ["node_modules"];
    return {
      ...config,
      resolve: {
        ...resolve,
        alias: { ...alias, [JOB_SCENES_ALIAS]: scenesIndex },
        modules: [...modules, path.join(REMOTION_APP_DIR, "node_modules")],
      },
    } as typeof config;
  };
}

export interface BundleJobInternalOptions {
  jobDir: string;
  signal?: AbortSignal;
  /** rspack (дефолт) або webpack. */
  rspack?: boolean;
  enableCaching?: boolean;
  onProgress?: (percent: number) => void;
}

/** Бандл хоста зі сценами задачі в `<jobDir>/bundle`; public/ задачі копіюється в бандл. */
export async function bundleJobDir(opts: BundleJobInternalOptions): Promise<{ serveUrl: string }> {
  const paths = jobPaths(opts.jobDir);
  if (!existsSync(paths.scenesIndex)) {
    throw new Error(`bundleJob: немає ${paths.scenesIndex} (реєстр сцен задачі)`);
  }
  opts.signal?.throwIfAborted();
  await mkdir(paths.publicDir, { recursive: true });
  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    outDir: paths.bundleDir,
    publicDir: paths.publicDir,
    rspack: opts.rspack ?? true,
    enableCaching: opts.enableCaching ?? true,
    bundlerOverride: jobOverride(paths.scenesIndex),
    onProgress: opts.onProgress ?? (() => undefined),
  });
  opts.signal?.throwIfAborted();
  return { serveUrl };
}
