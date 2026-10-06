/** Виконує задачі з обмеженням паралельності; порядок результатів = порядок входу. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

/** Обриває очікування промісу через `ms` (сам проміс не скасовується). */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "операція"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label}: перевищено ${ms} мс`)), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
