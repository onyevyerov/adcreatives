import {
  EPIDEMIC_DOWNLOAD_LIMIT,
  EPIDEMIC_DOWNLOAD_SOFT_LIMIT,
  type EpidemicDownloadKind,
  EpidemicError,
  type EpidemicLike,
  type EpidemicQuota,
  type EpidemicRequestOptions,
} from "../src/provider.ts";

type Method = keyof EpidemicLike;
type Reply = unknown | Error | ((...args: unknown[]) => unknown);

export interface EpidemicMockCall {
  method: Method;
  /** Аргументи виклику без `EpidemicRequestOptions`. */
  args: unknown[];
  options: EpidemicRequestOptions | undefined;
}

export type EpidemicFixtures = Partial<Record<Method, Reply[]>>;

/** Детерміновані відповіді, коли черга методу порожня. */
function defaultReply(method: Method, args: unknown[]): unknown {
  switch (method) {
    case "searchTracks":
      return { tracks: [] };
    case "searchSoundEffects":
      return { soundEffects: [] };
    case "trackDownloadUrl":
      return { url: `https://dl.example/track/${String(args[0])}.mp3`, expires: "2099-01-01T00:00:00Z" };
    case "soundEffectDownloadUrl":
      return { url: `https://dl.example/sfx/${String(args[0])}.mp3`, expires: "2099-01-01T00:00:00Z" };
    case "startVersion":
      return { jobId: `job-${(args[0] as { trackId: string }).trackId}`, status: "PENDING" };
    case "versionStatus":
      return {
        status: "COMPLETED",
        results: { highQualityUrl: `https://dl.example/version/${String(args[0])}.mp3` },
      };
    case "fetchBytes":
      return Buffer.from(`BYTES:${String(args[0])}`);
  }
}

/**
 * Мок `EpidemicLike` (за зразком `mockElevenLabs`): черга відповідей на кожен метод; Error у черзі —
 * кидається, функція — викликається з аргументами. Порожня черга — детермінована відповідь.
 */
export function mockEpidemic(fixtures: EpidemicFixtures = {}): EpidemicLike & { calls: EpidemicMockCall[] } {
  const calls: EpidemicMockCall[] = [];
  const queues = new Map<Method, Reply[]>(
    Object.entries(fixtures).map(([m, replies]) => [m as Method, [...(replies ?? [])]]),
  );
  const take = async (method: Method, args: unknown[], options?: EpidemicRequestOptions) => {
    calls.push({ method, args, options });
    const queue = queues.get(method) ?? [];
    if (queue.length === 0) return defaultReply(method, args);
    const item = queue.shift();
    const value = typeof item === "function" ? (item as (...a: unknown[]) => unknown)(...args) : item;
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    calls,
    searchTracks: (q, o) => take("searchTracks", [q], o) as ReturnType<EpidemicLike["searchTracks"]>,
    trackDownloadUrl: (id, q, o) =>
      take("trackDownloadUrl", [id, q], o) as ReturnType<EpidemicLike["trackDownloadUrl"]>,
    startVersion: (body, o) => take("startVersion", [body], o) as ReturnType<EpidemicLike["startVersion"]>,
    versionStatus: (jobId, o) =>
      take("versionStatus", [jobId], o) as ReturnType<EpidemicLike["versionStatus"]>,
    searchSoundEffects: (q, o) =>
      take("searchSoundEffects", [q], o) as ReturnType<EpidemicLike["searchSoundEffects"]>,
    soundEffectDownloadUrl: (id, q, o) =>
      take("soundEffectDownloadUrl", [id, q], o) as ReturnType<EpidemicLike["soundEffectDownloadUrl"]>,
    fetchBytes: (url, o) => take("fetchBytes", [url], o) as ReturnType<EpidemicLike["fetchBytes"]>,
  };
}

export interface ConsumedDownload {
  kind: EpidemicDownloadKind;
  id: string;
  detail: string | null;
}

/** `EpidemicQuota` у пам'яті з тим самим порогом, що й справжня; журнал `consumed`. */
export function memoryQuota(start = 0): EpidemicQuota & { consumed: ConsumedDownload[] } {
  let used = start;
  const consumed: ConsumedDownload[] = [];
  return {
    consumed,
    used: async () => used,
    consume: async (kind, id, detail) => {
      if (used >= EPIDEMIC_DOWNLOAD_SOFT_LIMIT) {
        throw new EpidemicError(
          "quota",
          `Epidemic: витрачено ${used} з ${EPIDEMIC_DOWNLOAD_LIMIT} завантажень, поріг ${EPIDEMIC_DOWNLOAD_SOFT_LIMIT} — прогін зупинено`,
        );
      }
      used += 1;
      consumed.push({ kind, id, detail: detail ?? null });
      return used;
    },
  };
}
