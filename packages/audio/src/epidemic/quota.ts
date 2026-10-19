import type { EpidemicQuota } from "../provider.ts";

/**
 * Тека Epidemic (лічильник `downloads.json` і кеш завантажень): `ADC_EPIDEMIC_DIR`, інакше
 * `<корінь репо>/.data/epidemic` — не DATA_DIR прогону. Заглушка Кроку 0: наповнює B1.
 */
export function epidemicDir(env: Record<string, string | undefined> = process.env): string {
  void env;
  throw new Error("not implemented");
}

/** Лічильник завантажень у `<dir>/downloads.json`. Заглушка Кроку 0: наповнює B1. */
export function createEpidemicQuota(dir: string): EpidemicQuota {
  void dir;
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return { used: notImplemented, consume: notImplemented };
}
