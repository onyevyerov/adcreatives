import { BrandKitFile, projectPaths, type Storage } from "@adc/shared";

/** Версії бренд-кіта: `brandkit/v<k>.json`. */

const VERSION_FILE = /\/v(\d+)\.json$/;

/** Найбільша наявна версія; 0 — бренд-кіта ще немає. */
export async function latestBrandkitVersion(storage: Storage, projectId: string): Promise<number> {
  const keys = await storage.list(projectPaths(projectId).brandkitDir);
  let max = 0;
  for (const key of keys) {
    const m = VERSION_FILE.exec(key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export async function readBrandkit(
  storage: Storage,
  projectId: string,
  version: number,
): Promise<BrandKitFile> {
  return storage.readJson(projectPaths(projectId).brandkit(version), (v) => BrandKitFile.parse(v));
}

/** Ключ контакт-листа асетів (поруч із версіями бренд-кіта). */
export function contactSheetKey(projectId: string): string {
  return `${projectPaths(projectId).brandkitDir}/contact-sheet.png`;
}
