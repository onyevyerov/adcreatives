import path from "node:path";
import {
  type Asset,
  type AssetRef,
  AudioManifest,
  BrandKit,
  type BrandKitFile,
  computeTimeline,
  type Format,
  type MainProps,
  type ProjectState,
  revPaths,
  type ScenePreviewProps,
  type Storage,
  type Storyboard,
} from "@adc/shared";
import { scenesIndexSource } from "./files.ts";
import { readAssets, readCurrentBrandKit, readOptional, readProject, readStoryboard } from "./io.ts";
import { readLedger, rejectedScenes } from "./ledger.ts";

/**
 * Підготовка теки задачі `rev/<n>/video` для бандла і рендера — спільна для `check` (ScenePreview)
 * і рендер-стадії воркера (`prepareRenderJob`, Main):
 * - `video/scenes/index.ts` — реєстр сцен (код генерує режисер);
 * - `video/public/assets/<assetId>.<ext>` — асети з `crawl/assets.json` / `uploads/` (для BrandImage/Logo);
 * - аудіо (`video/public/music.mp3`, `sfx/…`) кладе стадія `audio`, тут лише читається `audio.json`.
 */

export const PUBLIC_ASSETS_DIR = "assets";

/** Які асети потрібні ролику: зі сцен, лого і ранжовані в бренд-кіті. */
export function neededAssetIds(storyboard: Storyboard, brand: BrandKit): string[] {
  const ids = new Set<string>();
  for (const s of storyboard.scenes) for (const id of s.assetIds) ids.add(id);
  if (brand.logo.assetId) ids.add(brand.logo.assetId);
  for (const a of brand.assets) ids.add(a.assetId);
  return [...ids];
}

function extOf(asset: Asset): string {
  const fromPath = path.posix.extname(asset.path).toLowerCase();
  if (fromPath) return fromPath;
  if (asset.mime === "image/svg+xml") return ".svg";
  if (asset.mime === "image/png") return ".png";
  if (asset.mime === "image/webp") return ".webp";
  return ".jpg";
}

/** Копіює асети в `video/public/assets/` (наявні не перезаписує) і будує мапу AssetRef. */
export async function syncPublicAssets(
  storage: Storage,
  projectId: string,
  rev: number,
  brand: BrandKit,
  storyboard: Storyboard,
  manifest: readonly Asset[],
): Promise<{ assets: Record<string, AssetRef>; written: string[] }> {
  const rp = revPaths(projectId, rev);
  const byId = new Map(manifest.map((a) => [a.id, a]));
  const focal = new Map(brand.assets.map((a) => [a.assetId, a.cropFocus]));
  const assets: Record<string, AssetRef> = {};
  const written: string[] = [];
  for (const id of neededAssetIds(storyboard, brand)) {
    const asset = byId.get(id);
    if (!asset) continue;
    const src = `${PUBLIC_ASSETS_DIR}/${id}${extOf(asset)}`;
    const dest = rp.publicFile(src);
    if (!(await storage.exists(dest))) {
      if (!(await storage.exists(asset.path))) continue;
      await storage.copy(asset.path, dest);
      written.push(dest);
    }
    assets[id] = {
      src,
      width: asset.width,
      height: asset.height,
      focal: focal.get(id) ?? { x: 0.5, y: 0.5 },
    };
  }
  return { assets, written };
}

/**
 * Пише `video/scenes/index.ts` зі сцен розкадровки, файли яких є в `video/scenes/`,
 * крім `exclude` (сцени на TemplateScene або з помилками компіляції).
 */
export async function writeScenesIndex(
  storage: Storage,
  projectId: string,
  rev: number,
  storyboard: Storyboard,
  exclude: Iterable<string> = [],
): Promise<{ key: string; sceneIds: string[] }> {
  const rp = revPaths(projectId, rev);
  const skip = new Set(exclude);
  const ids: string[] = [];
  for (const s of storyboard.scenes) {
    if (skip.has(s.id)) continue;
    if (await storage.exists(rp.scene(s.id))) ids.push(s.id);
  }
  await storage.write(rp.scenesIndex, scenesIndexSource(ids));
  return { key: rp.scenesIndex, sceneIds: ids };
}

export interface PreparedJob {
  /** Абсолютний шлях `rev/<n>/video` (для `RenderEngine.bundleJob`). */
  jobDir: string;
  project: ProjectState | null;
  brandFile: BrandKitFile;
  /** BrandKit без метаданих версії — як у MainProps. */
  brand: BrandKit;
  storyboard: Storyboard;
  assets: Record<string, AssetRef>;
  audio: AudioManifest;
  /** Сцени в реєстрі `scenes/index.ts`. */
  indexedScenes: string[];
  /** Записані/оновлені ключі сховища. */
  written: string[];
}

export interface PrepareJobOptions {
  storage: Storage;
  projectId: string;
  rev: number;
  /** Не включати в реєстр (TemplateScene, помилки компіляції). */
  excludeFromIndex?: Iterable<string>;
  /** Уже прочитані дані (щоб не читати двічі). */
  project?: ProjectState | null;
  brandFile?: BrandKitFile;
  storyboard?: Storyboard;
}

export async function prepareJob(opts: PrepareJobOptions): Promise<PreparedJob> {
  const { storage, projectId, rev } = opts;
  const rp = revPaths(projectId, rev);
  const project = opts.project !== undefined ? opts.project : await readProject(storage, projectId);
  const brandFile = opts.brandFile ?? (await readCurrentBrandKit(storage, projectId, project));
  const brand = BrandKit.parse(brandFile);
  const storyboard = opts.storyboard ?? (await readStoryboard(storage, projectId, rev));
  const manifest = await readAssets(storage, projectId);
  const { assets, written } = await syncPublicAssets(storage, projectId, rev, brand, storyboard, manifest);
  const audio =
    (await readOptional(storage, rp.audio, (v) => AudioManifest.parse(v))) ??
    ({
      music: null,
      mix: null,
      sfx: [],
      totalFrames: computeTimeline(storyboard).totalFrames,
    } satisfies AudioManifest);
  // Поточна версія, відхилена AST-guard, у реєстр не йде, навіть якщо на диску лишився старий файл.
  const rejected = rejectedScenes(await readLedger(storage, projectId, rev));
  const index = await writeScenesIndex(storage, projectId, rev, storyboard, [
    ...(opts.excludeFromIndex ?? []),
    ...rejected,
  ]);
  written.push(index.key);
  return {
    jobDir: storage.absPath(rp.videoDir),
    project,
    brandFile,
    brand,
    storyboard,
    assets,
    audio,
    indexedScenes: index.sceneIds,
    written,
  };
}

export interface PrepareRenderJobOptions {
  storage: Storage;
  projectId: string;
  rev: number;
  format: Format;
  /** Сцени, які малює TemplateScene (рішення оркестратора, `pipeline.json`). */
  templateScenes: string[];
}

/**
 * Для рендер-стадії воркера (B8): збирає MainProps і гарантує, що `video/scenes/index.ts` і
 * файли `video/public/` на місці. Сцени з `templateScenes` не потрапляють у реєстр — їх малює
 * TemplateScene (і їхній код, навіть битий, не ламає бандл).
 */
export async function prepareRenderJob(
  opts: PrepareRenderJobOptions,
): Promise<{ jobDir: string; mainProps: MainProps }> {
  const job = await prepareJob({
    storage: opts.storage,
    projectId: opts.projectId,
    rev: opts.rev,
    excludeFromIndex: opts.templateScenes,
  });
  return {
    jobDir: job.jobDir,
    mainProps: {
      brand: job.brand,
      storyboard: job.storyboard,
      format: opts.format,
      assets: job.assets,
      audio: job.audio,
      templateScenes: [...opts.templateScenes],
      qa: false,
    },
  };
}

/** Пропси ScenePreview для стілів (check) — з тієї ж підготовленої задачі. */
export function scenePreviewProps(
  job: Pick<PreparedJob, "brand" | "storyboard" | "assets">,
  sceneId: string,
  format: Format,
  useTemplate: boolean,
): ScenePreviewProps {
  return {
    brand: job.brand,
    storyboard: job.storyboard,
    sceneId,
    format,
    assets: job.assets,
    useTemplate,
    qa: true,
  };
}
