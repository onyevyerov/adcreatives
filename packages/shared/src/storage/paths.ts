import type { Format } from "../schemas/common.ts";

/**
 * Ключі артефактів у сховищі (відносно DATA_DIR). Єдине місце, де зашиті імена файлів.
 * POSIX-шляхи: Storage сам перетворює їх на шляхи ОС.
 */

const join = (...parts: Array<string | number>): string => parts.map(String).join("/");

export const PROJECTS_DIR = "projects";

export const sharedPaths = {
  costs: "costs-shared.jsonl",
  sfxCacheDir: join("cache", "sfx"),
  sfxCache: (hash: string) => join("cache", "sfx", `${hash}.mp3`),
  sfxCacheMeta: (hash: string) => join("cache", "sfx", `${hash}.json`),
};

export function revPaths(projectId: string, rev: number) {
  const root = join(PROJECTS_DIR, projectId, "rev", rev);
  const video = join(root, "video");
  return {
    root,
    storyboard: join(root, "storyboard.json"),
    claims: join(root, "claims.json"),
    videoDir: video,
    scenesDir: join(video, "scenes"),
    scene: (sceneId: string) => join(video, "scenes", `${sceneId}.tsx`),
    scenesIndex: join(video, "scenes", "index.ts"),
    publicDir: join(video, "public"),
    publicFile: (name: string) => join(video, "public", name),
    bundleDir: join(video, "bundle"),
    still: (format: Format, sceneId: string, variant: "a" | "b") =>
      join(root, "stills", format, `${sceneId}-${variant}.png`),
    sheet: (format: Format) => join(root, "sheets", `${format}.png`),
    check: join(root, "check.json"),
    qa: join(root, "qa.json"),
    pipeline: join(root, "pipeline.json"),
    audioPlan: join(root, "audio-plan.json"),
    audio: join(root, "audio.json"),
    render: (format: Format) => join(root, "renders", `${format}.mp4`),
    poster: join(root, "poster.png"),
    inputs: join(root, "inputs.json"),
  };
}
export type RevPaths = ReturnType<typeof revPaths>;

export function projectPaths(projectId: string) {
  const root = join(PROJECTS_DIR, projectId);
  return {
    root,
    project: join(root, "project.json"),
    uploadsDir: join(root, "uploads"),
    upload: (fileName: string) => join(root, "uploads", fileName),
    crawlDir: join(root, "crawl"),
    site: join(root, "crawl", "site.json"),
    assets: join(root, "crawl", "assets.json"),
    assetsDir: join(root, "crawl", "assets"),
    asset: (fileName: string) => join(root, "crawl", "assets", fileName),
    screenshotsDir: join(root, "crawl", "screenshots"),
    screenshot: (fileName: string) => join(root, "crawl", "screenshots", fileName),
    brandkitDir: join(root, "brandkit"),
    brandkit: (version: number) => join(root, "brandkit", `v${version}.json`),
    /** Контакт-лист асетів (монтаж мініатюр з номерами), вхід бренд-кіта. */
    contactSheet: join(root, "brandkit", "contact-sheet.png"),
    audioDir: join(root, "audio"),
    music: (planHash: string) => join(root, "audio", planHash, "music.mp3"),
    musicMeta: (planHash: string) => join(root, "audio", planHash, "music.json"),
    sfxDir: join(root, "audio", "sfx"),
    sfx: (fileName: string) => join(root, "audio", "sfx", fileName),
    costs: join(root, "costs.jsonl"),
    trace: join(root, "trace.jsonl"),
    revDir: join(root, "rev"),
    rev: (n: number) => revPaths(projectId, n),
  };
}
export type ProjectPaths = ReturnType<typeof projectPaths>;
