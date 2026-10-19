import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { findRepoRoot } from "@adc/shared";
import {
  EPIDEMIC_DOWNLOAD_LIMIT,
  EPIDEMIC_DOWNLOAD_SOFT_LIMIT,
  EPIDEMIC_DOWNLOADS_FILE,
  EpidemicDownloadsFile,
  EpidemicError,
  type EpidemicQuota,
} from "../provider.ts";

/**
 * Тека Epidemic (лічильник `downloads.json` і кеш завантажень): `ADC_EPIDEMIC_DIR` (відносний — від
 * кореня репо), інакше `<корінь репо>/.data/epidemic`. Свідомо **не** DATA_DIR: у eval він свій на
 * кожен прогін, і лічильник обнулювався б (пастка §6.1 дизайну).
 */
export function epidemicDir(env: Record<string, string | undefined> = process.env): string {
  const custom = env.ADC_EPIDEMIC_DIR?.trim();
  if (custom) return path.resolve(findRepoRoot(), custom);
  return path.join(findRepoRoot(), ".data", "epidemic");
}

/**
 * rename поверх наявного файлу. На Linux атомарний; на Windows може тимчасово впасти з
 * EPERM/EBUSY/EACCES, якщо файл саме відкритий читачем, — кілька коротких повторів
 * (копія `renameReplacing` з `@adc/shared` storage/local.ts, там вона не експортується).
 */
async function renameReplacing(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((r) => setTimeout(r, 5 * (i + 1)));
    }
  }
}

/** Послідовність consume у межах процесу на кожен файл (Promise.all не губить інкременти). */
const locks = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => undefined);
  locks.set(key, settled);
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

/**
 * Лічильник завантажень у `<dir>/downloads.json` (схема `EpidemicDownloadsFile`). Файл читається
 * щоразу (один eval-процес — досить), запис атомарний (tmp + rename). Поріг 45 з 50 зупиняє прогін;
 * прапорця обходу немає свідомо (анти-ціль «квоту витрачено на повтори»).
 */
export function createEpidemicQuota(dir: string): EpidemicQuota {
  const file = path.join(path.resolve(dir), EPIDEMIC_DOWNLOADS_FILE);

  async function load(): Promise<EpidemicDownloadsFile> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, used: 0, events: [] };
      throw err;
    }
    try {
      return EpidemicDownloadsFile.parse(JSON.parse(raw));
    } catch (err) {
      // Не обнуляємо мовчки: зіпсований лічильник — привід зупинитись і розібратись руками.
      throw new Error(`Epidemic: зіпсований лічильник ${file}: ${(err as Error).message}`, { cause: err });
    }
  }

  async function save(data: EpidemicDownloadsFile): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
      await renameReplacing(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  return {
    used: async () => (await load()).used,
    consume: (kind, id, detail) =>
      serialized(file, async () => {
        const data = await load();
        if (data.used >= EPIDEMIC_DOWNLOAD_SOFT_LIMIT) {
          throw new EpidemicError(
            "quota",
            `Epidemic: витрачено ${data.used} з ${EPIDEMIC_DOWNLOAD_LIMIT} завантажень, поріг ${EPIDEMIC_DOWNLOAD_SOFT_LIMIT} — прогін зупинено`,
          );
        }
        const next: EpidemicDownloadsFile = {
          version: 1,
          used: data.used + 1,
          events: [...data.events, { ts: new Date().toISOString(), kind, id, detail: detail ?? null }],
        };
        await save(next);
        return next.used;
      }),
  };
}
