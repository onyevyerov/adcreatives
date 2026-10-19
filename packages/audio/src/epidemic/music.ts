import { type AudioPlan, type Logger, type MusicMeta, noopLogger } from "@adc/shared";
import { z } from "zod";
import { type DecodeAudio, decodeAudio } from "../decode.ts";
import {
  type Attempt,
  cachedMusic,
  type EnsuredMusic,
  finalizeMusic,
  type GeneratedMusic,
} from "../music.ts";
import { pcmLength } from "../pcm.ts";
import { musicPlanHashFor, planTrackMs, planVideoMs } from "../plan.ts";
import {
  type EnsureMusicFn,
  EpidemicError,
  type EpidemicErrorKind,
  type EpidemicLike,
  type EpidemicRequestOptions,
  type EpidemicTrack,
} from "../provider.ts";
import { betterCheck, checkTrack } from "../trackCheck.ts";
import { classifyEpidemicError } from "./errors.ts";

/**
 * Музика з каталогу Epidemic Sound (дизайн §4.2, §9.1): пошук за `promptFallback` з фільтром темпу
 * розкадровки → вибір LLM за метаданими → підгонка під тривалість (бета Create versions, фолбек —
 * повний трек) → той самий `checkTrack` і хвіст `finalizeMusic`, що в ElevenLabs. Кожне завантаження
 * лічиться квотою; байти лежать у постійному кеші Epidemic, тож повторний прогін того самого треку
 * завантажень не витрачає.
 */

/** `modelId` у `music.json` і модель у `costs.jsonl`. */
export const EPIDEMIC_MUSIC_MODEL_ID = "epidemic-catalog";
/** Промпт вибору треку серед кандидатів. */
export const MUSIC_PICK_PROMPT = "epidemic/music-pick";
/** `term` пошуку Epidemic — не довше 500 символів. */
export const EPIDEMIC_TERM_MAX = 500;
/** Скільки треків бере один пошук і скільки кандидатів іде на вибір LLM. */
export const EPIDEMIC_SEARCH_LIMIT = 30;
export const EPIDEMIC_MUSIC_CANDIDATES = 5;
/** Допуск темпу: раунд 1 і раунд 2 (BPM у темпі розкадровки). */
export const EPIDEMIC_TEMPO_TOLERANCES = [6, 10] as const;
/** Нижня межа `bpmMin`/`bpmMax` у пошуку. */
export const EPIDEMIC_MIN_SEARCH_BPM = 40;
/** Опитування Create versions: інтервал і загальний таймаут. */
export const EPIDEMIC_VERSION_POLL_MS = 3_000;
export const EPIDEMIC_VERSION_TIMEOUT_MS = 5 * 60_000;

/** Відповідь LLM на `epidemic/music-pick`. */
export const MusicPickDraft = z.object({ trackId: z.string(), reason: z.string() });
export type MusicPickDraft = z.infer<typeof MusicPickDraft>;

/** Залежності провайдера; `sleep` — для опитування версії в тестах (дефолт — справжній таймер). */
export type EpidemicMusicDeps = Parameters<EnsureMusicFn>[0] & { sleep?: (ms: number) => Promise<void> };

/** Ключ байтів треку в постійному кеші Epidemic: `music/<trackId>-<durationMs>.mp3`. */
export const epidemicMusicCacheKey = (trackId: string, durationMs: number) =>
  `music/${trackId}-${durationMs}.mp3`;

/**
 * Відхилення темпу треку від цільового в одиницях цільового темпу: трек, його подвоєння або
 * половина (half-time/double-time грув так само ляже на сітку); null — темп невідомий.
 */
export function tempoDeviation(bpm: number | null, target: number): number | null {
  if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) return null;
  return Math.min(Math.abs(bpm - target), Math.abs(bpm * 2 - target), Math.abs(bpm / 2 - target));
}

/** Чи трек (його половина або подвоєння) у межах `±tolerance` від цільового темпу; null — ні. */
export function tempoMatches(bpm: number | null, target: number, tolerance: number): boolean {
  const d = tempoDeviation(bpm, target);
  return d !== null && d <= tolerance;
}

/** Діапазони `bpmMin/bpmMax` раунду: [t±tol], [t/2 ± tol/2], [2t ± 2·tol] — цілі, не нижче 40. */
export function tempoRanges(target: number, tolerance: number): Array<{ bpmMin: number; bpmMax: number }> {
  const raw: Array<[number, number]> = [
    [target - tolerance, target + tolerance],
    [target / 2 - tolerance / 2, target / 2 + tolerance / 2],
    [target * 2 - tolerance * 2, target * 2 + tolerance * 2],
  ];
  return raw
    .map(([lo, hi]) => ({
      bpmMin: Math.max(EPIDEMIC_MIN_SEARCH_BPM, Math.floor(lo)),
      bpmMax: Math.ceil(hi),
    }))
    .filter((r) => r.bpmMax >= r.bpmMin);
}

/** Треки без дублікатів за `id`, відсортовані за відхиленням темпу, далі — за порядком пошуку. */
function rankByTempo(tracks: readonly EpidemicTrack[], target: number, tolerance: number | null) {
  const seen = new Set<string>();
  const ranked: Array<{ track: EpidemicTrack; dev: number; order: number }> = [];
  tracks.forEach((track, order) => {
    if (seen.has(track.id)) return;
    seen.add(track.id);
    const dev = tempoDeviation(track.bpm, target);
    if (tolerance !== null && (dev === null || dev > tolerance)) return;
    ranked.push({ track, dev: dev ?? Number.POSITIVE_INFINITY, order });
  });
  ranked.sort((a, b) => a.dev - b.dev || a.order - b.order);
  return ranked.map((r) => r.track).slice(0, EPIDEMIC_MUSIC_CANDIDATES);
}

export interface EpidemicCandidates {
  /** Найкращі за темпом, не більше 5; у раунді 3 — найближчий першим. */
  candidates: EpidemicTrack[];
  /** Раунд 3: жоден трек не в допуску ±10 — узято найближчі. */
  tempoWarning: boolean;
  /** Пошуковий запит (`promptUsed` у `music.json`). */
  term: string;
}

type Run = <T>(label: string, fn: (o: EpidemicRequestOptions) => Promise<T>) => Promise<T>;

/**
 * Кандидати під темп `target` (дизайн §9.1): раунд 1 — три пошуки з допуском ±6 (темп, половина,
 * подвоєння), раунд 2 — те саме з ±10, раунд 3 — один пошук без темпу і найближчі за темпом
 * (`tempoWarning`). Пошуки завантажень не витрачають.
 */
export async function findEpidemicCandidates(
  run: Run,
  client: () => EpidemicLike,
  plan: AudioPlan,
  target: number,
): Promise<EpidemicCandidates> {
  const term = plan.promptFallback.slice(0, EPIDEMIC_TERM_MAX);
  const base = {
    term,
    vocalType: ["NONE" as const],
    limit: EPIDEMIC_SEARCH_LIMIT,
    sort: "Relevance" as const,
  };
  for (const tolerance of EPIDEMIC_TEMPO_TOLERANCES) {
    const found: EpidemicTrack[] = [];
    for (const range of tempoRanges(target, tolerance)) {
      const res = await run("music:search", (o) => client().searchTracks({ ...base, ...range }, o));
      found.push(...res.tracks);
    }
    const candidates = rankByTempo(found, target, tolerance);
    if (candidates.length > 0) return { candidates, tempoWarning: false, term };
  }
  const res = await run("music:search", (o) => client().searchTracks(base, o));
  return { candidates: rankByTempo(res.tracks, target, null), tempoWarning: true, term };
}

/** Рядок таблиці кандидатів для промпта (лише метадані каталогу). */
const candidateRow = (t: EpidemicTrack) => ({
  id: t.id,
  title: t.title,
  artists: t.mainArtists,
  bpm: t.bpm,
  lengthSeconds: t.length,
  moods: t.moods.map((m) => m.name),
  genres: t.genres.map((g) => g.name),
});

const errorKind = (err: unknown): EpidemicErrorKind =>
  err instanceof EpidemicError ? err.kind : classifyEpidemicError(err).kind;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Fetched {
  audio: Buffer;
  versionJobId: string | null;
}

interface Tried extends Attempt {
  fetched: Fetched;
  /** Байти не розкодовано (немає ffmpeg) — на відміну від короткого треку, повтор не допоможе. */
  undecodable: boolean;
}

/**
 * Трек з каталогу Epidemic під план музики:
 * 1) кеш-хіт `audio/<planHash>/` (`musicPlanHashFor("epidemic")`) — без викликів і завантажень;
 * 2) кандидати за темпом розкадровки (`findEpidemicCandidates`);
 * 3) вибір LLM (`epidemic/music-pick`, один виклик; кандидат один — без виклику; невідомий id — перший);
 * 4) байти: постійний кеш `music/<trackId>-<durationMs>.mp3`, інакше Create versions на тривалість
 *    треку плану (відео + 8 с) з опитуванням, фолбек — повний трек high;
 * 5) `checkTrack`; `ok=false` — рівно один повтор з наступним кандидатом, далі `betterCheck`;
 * 6) `finalizeMusic`: вікно відео, `music.wav`, `music.json` з `provider: "epidemic"`.
 */
export const ensureEpidemicMusic = (async (
  deps: EpidemicMusicDeps,
  projectId: string,
  plan: AudioPlan,
  briefHash: string,
): Promise<EnsuredMusic> => {
  const ep = deps.epidemic;
  const logger: Logger = ep.logger ?? deps.logger ?? noopLogger;
  const signal = ep.signal ?? deps.signal;
  const planHash = musicPlanHashFor("epidemic", plan);
  const hit = await cachedMusic(deps.storage, projectId, planHash);
  if (hit) return { ...hit, downloads: 0 };

  const run: Run = (label, fn) => ep.gate.run(label, (s) => fn(s ? { signal: s } : {}), signal);
  const target = deps.targetBpm;
  const trackMs = planTrackMs(plan);
  const videoMs = planVideoMs(plan);
  const sleep = deps.sleep ?? realSleep;
  const decode: DecodeAudio = deps.decode ?? decodeAudio;
  let downloads = 0;

  const found = await findEpidemicCandidates(run, ep.client, plan, target);
  if (found.candidates.length === 0) {
    throw new EpidemicError("not_found", "Epidemic: пошук музики не дав жодного треку");
  }
  if (found.tempoWarning) {
    logger.warn("Epidemic: жоден трек не в допуску темпу ±10 — беремо найближчий", {
      targetBpm: target,
      bpm: found.candidates[0]?.bpm ?? null,
    });
  }
  const order = await pickOrder(deps, found, plan, target, videoMs, logger, signal);

  const record = async (trackId: string, seconds: number) => {
    try {
      await deps.cost.record({
        provider: "epidemic",
        kind: "music",
        model: EPIDEMIC_MUSIC_MODEL_ID,
        seconds,
        detail: `music:epidemic:${trackId}`,
      });
    } catch (err) {
      logger.error("не вдалося записати витрати музики", { err: String(err) });
    }
  };

  /** Повторне кидання: скасування і квота — назовні, решта — збій версії (фолбек). */
  const fatal = (err: unknown) => {
    const kind = errorKind(err);
    if (signal?.aborted || kind === "aborted" || kind === "quota") throw err;
    return kind;
  };

  /** Підгонка під тривалість (бета): байти версії або null — збій чи таймаут. */
  const fetchVersion = async (track: EpidemicTrack): Promise<Fetched | null> => {
    await ep.quota.consume("version", track.id, `durationMs=${trackMs}`);
    downloads += 1;
    try {
      const job = await run("music:version", (o) =>
        ep.client().startVersion({ trackId: track.id, durationMs: trackMs }, o),
      );
      // Відповідь старту URL не має — опитуємо щонайменше раз; не PENDING/COMPLETED — збій.
      let status = job.status;
      let url: string | undefined;
      for (let waited = 0; status === "PENDING" || status === "COMPLETED"; ) {
        if (waited >= EPIDEMIC_VERSION_TIMEOUT_MS) {
          status = "TIMEOUT";
          break;
        }
        await sleep(EPIDEMIC_VERSION_POLL_MS);
        waited += EPIDEMIC_VERSION_POLL_MS;
        const res = await run("music:version-status", (o) => ep.client().versionStatus(job.jobId, o));
        status = res.status;
        if (status === "COMPLETED") {
          url = res.results?.highQualityUrl;
          break;
        }
      }
      if (status !== "COMPLETED" || !url) {
        logger.warn("Epidemic: версія треку не готова — беремо повний трек", {
          trackId: track.id,
          jobId: job.jobId,
          status,
        });
        return null;
      }
      const versionUrl = url;
      await ep.quota.consume("version_fetch", track.id, job.jobId);
      downloads += 1;
      const audio = await run("music:download", (o) => ep.client().fetchBytes(versionUrl, o));
      await record(track.id, trackMs / 1000);
      return { audio, versionJobId: job.jobId };
    } catch (err) {
      const kind = fatal(err);
      logger.warn("Epidemic: збій версії треку — беремо повний трек", {
        trackId: track.id,
        kind,
        err: String(err),
      });
      return null;
    }
  };

  /** Байти кандидата: постійний кеш, інакше версія, інакше повний трек. */
  const fetchTrack = async (track: EpidemicTrack): Promise<Fetched> => {
    const key = epidemicMusicCacheKey(track.id, trackMs);
    if (await ep.cache.exists(key)) {
      logger.info("Epidemic: трек з кешу завантажень", { trackId: track.id });
      return { audio: await ep.cache.read(key), versionJobId: null };
    }
    let fetched = await fetchVersion(track);
    if (!fetched) {
      await ep.quota.consume("track", track.id, "high");
      downloads += 1;
      const { url } = await run("music:download-url", (o) =>
        ep.client().trackDownloadUrl(track.id, { quality: "high" }, o),
      );
      const audio = await run("music:download", (o) => ep.client().fetchBytes(url, o));
      await record(track.id, track.length);
      fetched = { audio, versionJobId: null };
    }
    await ep.cache.write(key, fetched.audio);
    return fetched;
  };

  /** Спроба кандидата: байти → декодування → перевірка (null — не розкодовано / коротший за відео). */
  const attempt = async (track: EpidemicTrack): Promise<Tried> => {
    const fetched = await fetchTrack(track);
    const music: GeneratedMusic = {
      audio: fetched.audio,
      // Поле ElevenLabs (у `music.json` не йде): mp3 Epidemic high — найближчий формат зі списку.
      outputFormat: "mp3_44100_192",
      method: "catalog",
      promptUsed: found.term,
      durationMs: fetched.versionJobId ? trackMs : Math.round(track.length * 1000),
    };
    let pcm: Attempt["pcm"];
    try {
      pcm = await decode(fetched.audio, signal ? { signal } : {});
    } catch (err) {
      if (signal?.aborted) throw err;
      logger.warn("музику не вдалося розкодувати — без перевірки й обрізання", {
        trackId: track.id,
        err: String(err),
      });
      return { music, pcm: null, check: null, fetched, undecodable: true };
    }
    const lengthMs = (pcmLength(pcm) / pcm.sampleRate) * 1000;
    music.durationMs = Math.round(lengthMs);
    if (lengthMs < videoMs) {
      logger.warn("Epidemic: трек коротший за відео — без перевірки й обрізання", {
        trackId: track.id,
        lengthMs: Math.round(lengthMs),
        videoMs,
      });
      return { music, pcm: null, check: null, fetched, undecodable: false };
    }
    const check = checkTrack(pcm, target, { videoMs });
    logger.info("перевірка треку", {
      trackId: track.id,
      ok: check.ok,
      kickOnsets: check.kickOnsets,
      beatConfidence: check.beatConfidence,
      gaps: check.gaps.length,
    });
    return { music, pcm, check, fetched, undecodable: false };
  };

  // Перший кандидат і не більше одного повтору з наступним за списком (без нового виклику LLM).
  let best: { att: Tried; track: EpidemicTrack } | null = null;
  let tried = 0;
  for (const track of order.slice(0, 2)) {
    let att: Tried;
    try {
      att = await attempt(track);
    } catch (err) {
      if (!best || signal?.aborted || errorKind(err) === "quota") throw err;
      logger.warn("Epidemic: другий кандидат не вдався — беремо перший", { trackId: track.id });
      break;
    }
    tried += 1;
    if (!best?.att.check || (att.check && betterCheck(att.check, best.att.check))) best = { att, track };
    // Пройшов — готово; не розкодовано (немає ffmpeg) — другого кандидата не перевірити так само.
    // Провал перевірки або трек коротший за відео — наступний кандидат.
    if (att.check?.ok || att.undecodable) break;
  }
  if (!best) throw new Error("музика: немає жодної спроби");

  const { att, track } = best;
  const base: Omit<MusicMeta, "durationMs" | "check" | "offsetMs"> = {
    planHash,
    modelId: EPIDEMIC_MUSIC_MODEL_ID,
    provider: "epidemic",
    method: "catalog",
    promptUsed: found.term,
    briefHash,
    createdAt: (ep.now ?? deps.now ?? (() => new Date()))().toISOString(),
    attempts: Math.max(1, tried),
    epidemic: {
      trackId: track.id,
      title: track.title,
      artists: track.mainArtists,
      bpm: track.bpm,
      targetBpm: target,
      tempoWarning: found.tempoWarning,
      versionJobId: att.fetched.versionJobId,
      candidatesTried: Math.max(1, tried),
    },
  };
  const res = await finalizeMusic(deps, projectId, planHash, att, base, target, videoMs);
  return { ...res, downloads };
}) satisfies EnsureMusicFn;

/** Порядок кандидатів: обраний LLM першим, далі решта за списком пошуку. */
async function pickOrder(
  deps: EpidemicMusicDeps,
  found: EpidemicCandidates,
  plan: AudioPlan,
  targetBpm: number,
  videoMs: number,
  logger: Logger,
  signal: AbortSignal | undefined,
): Promise<EpidemicTrack[]> {
  const list = found.candidates;
  // Один кандидат або раунд 3 (найближчий за темпом) — без виклику LLM.
  if (list.length <= 1 || found.tempoWarning) return list;
  let chosen: string | null = null;
  try {
    const res = await deps.llm.structured(
      MUSIC_PICK_PROMPT,
      {
        promptFallback: plan.promptFallback,
        positiveStyles: plan.compositionPlan.positiveGlobalStyles,
        negativeStyles: plan.compositionPlan.negativeGlobalStyles,
        targetBpm,
        videoSeconds: Math.round(videoMs / 100) / 10,
        candidates: list.map(candidateRow),
      },
      MusicPickDraft,
      { ...(signal ? { signal } : {}), costDetail: "music-pick" },
    );
    chosen = res.data.trackId;
    logger.info("Epidemic: обрано трек", { trackId: chosen, reason: res.data.reason });
  } catch (err) {
    if (signal?.aborted) throw err;
    logger.warn("Epidemic: вибір треку LLM не вдався — беремо першого кандидата", { err: String(err) });
  }
  const idx = chosen === null ? -1 : list.findIndex((t) => t.id === chosen);
  if (chosen !== null && idx < 0) {
    logger.warn("Epidemic: LLM обрав невідомий трек — беремо першого кандидата", { trackId: chosen });
  }
  if (idx <= 0) return list;
  const picked = list[idx] as EpidemicTrack;
  return [picked, ...list.filter((_, i) => i !== idx)];
}
