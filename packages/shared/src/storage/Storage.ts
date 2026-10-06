/**
 * Сховище артефактів. Ключі — відносні POSIX-шляхи від DATA_DIR
 * (напр. `projects/<id>/rev/1/storyboard.json`). Абсолютні шляхи і `..` заборонені.
 * Файли автоматично не видаляються — методу remove свідомо немає.
 */
export interface Storage {
  read(key: string): Promise<Buffer>;
  readText(key: string): Promise<string>;
  /** Читає JSON; якщо передано parse (напр. `Schema.parse`), валідує. */
  readJson<T = unknown>(key: string, parse?: (value: unknown) => T): Promise<T>;
  write(key: string, data: string | Uint8Array): Promise<void>;
  writeJson(key: string, value: unknown): Promise<void>;
  /** Дописує рядок (з `\n` у кінці, якщо його немає). */
  append(key: string, line: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Ключі файлів під префіксом (рекурсивно), відсортовані. */
  list(prefix: string): Promise<string[]>;
  /** Імена безпосередніх підтек під префіксом. */
  listDirs(prefix: string): Promise<string[]>;
  copy(from: string, to: string): Promise<void>;
  /** URL для браузера: `/files/<key>`. */
  publicUrl(key: string): string;
  /** Абсолютний шлях на диску (для Remotion, Playwright, sharp). */
  absPath(key: string): string;
}

export class StorageKeyError extends Error {
  override name = "StorageKeyError";
}

export class NotFoundInStorageError extends Error {
  override name = "NotFoundInStorageError";
  constructor(public readonly key: string) {
    super(`немає файлу: ${key}`);
  }
}
