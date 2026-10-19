/**
 * Локальна черга викликів Epidemic (паралельність і повтори тимчасових відмов).
 * Заглушка Кроку 0: просто викликає `fn`; черга й повтори — B1.
 */
export class EpidemicGate {
  run<T>(label: string, fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    void label;
    return fn(signal);
  }
}
