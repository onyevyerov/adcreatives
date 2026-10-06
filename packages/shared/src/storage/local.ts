import { appendFile, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../env.ts";
import { NotFoundInStorageError, type Storage, StorageKeyError } from "./Storage.ts";

/** Нормалізує ключ сховища і відкидає все, що виходить за межі кореня. */
export function normalizeKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) throw new StorageKeyError("порожній ключ");
  if (key.includes("\0")) throw new StorageKeyError(`недопустимий ключ: ${key}`);
  const unified = key.replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    throw new StorageKeyError(`абсолютний шлях заборонено: ${key}`);
  }
  const normalized = path.posix.normalize(unified);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    throw new StorageKeyError(`шлях за межами сховища: ${key}`);
  }
  return normalized.replace(/\/$/, "");
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export class LocalStorage implements Storage {
  readonly root: string;

  constructor(
    root: string,
    private readonly urlPrefix = "/files",
  ) {
    this.root = path.resolve(root);
  }

  absPath(key: string): string {
    const abs = path.resolve(this.root, ...normalizeKey(key).split("/"));
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new StorageKeyError(`шлях за межами сховища: ${key}`);
    return abs;
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.absPath(key));
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundInStorageError(key);
      throw err;
    }
  }

  async readText(key: string): Promise<string> {
    return (await this.read(key)).toString("utf8");
  }

  async readJson<T = unknown>(key: string, parse?: (value: unknown) => T): Promise<T> {
    const value: unknown = JSON.parse(await this.readText(key));
    return parse ? parse(value) : (value as T);
  }

  async write(key: string, data: string | Uint8Array): Promise<void> {
    const abs = this.absPath(key);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.write(key, `${JSON.stringify(value, null, 2)}\n`);
  }

  async append(key: string, line: string): Promise<void> {
    const abs = this.absPath(key);
    await mkdir(path.dirname(abs), { recursive: true });
    await appendFile(abs, line.endsWith("\n") ? line : `${line}\n`);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.absPath(key));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const base = normalizeKey(prefix);
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(this.absPath(rel), { withFileTypes: true });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
      for (const e of entries) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(child);
        else if (e.isFile()) out.push(child);
      }
    };
    await walk(base);
    return out.sort();
  }

  async listDirs(prefix: string): Promise<string[]> {
    try {
      const entries = await readdir(this.absPath(prefix), { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async copy(from: string, to: string): Promise<void> {
    const dest = this.absPath(to);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await copyFile(this.absPath(from), dest);
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundInStorageError(from);
      throw err;
    }
  }

  publicUrl(key: string): string {
    return `${this.urlPrefix}/${normalizeKey(key).split("/").map(encodeURIComponent).join("/")}`;
  }
}

/** Сховище з DATA_DIR (відносно кореня репозиторію, дефолт `.data`). */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): LocalStorage {
  return new LocalStorage(dataDir(env));
}
