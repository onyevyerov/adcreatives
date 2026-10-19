import { EpidemicError, type EpidemicLike } from "../provider.ts";

/**
 * HTTP-клієнт Partner API Epidemic Sound (`https://api.epidemicsound.com`, `Authorization: Bearer <ключ>`).
 * Заглушка Кроку 0: без ключа — `unauthorized`, методи наповнює B1.
 */
export function createEpidemicClient(
  apiKey: string | undefined = process.env.EPIDEMIC_API_KEY,
  fetchImpl: typeof fetch = fetch,
): EpidemicLike {
  if (!apiKey?.trim()) throw new EpidemicError("unauthorized", "Epidemic: немає EPIDEMIC_API_KEY");
  void fetchImpl;
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return {
    searchTracks: notImplemented,
    trackDownloadUrl: notImplemented,
    startVersion: notImplemented,
    versionStatus: notImplemented,
    searchSoundEffects: notImplemented,
    soundEffectDownloadUrl: notImplemented,
    fetchBytes: notImplemented,
  };
}
