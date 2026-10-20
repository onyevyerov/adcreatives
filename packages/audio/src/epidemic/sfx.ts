import { type Logger, loadPrompt, noopLogger, projectPaths, SoundCue, shortHash } from "@adc/shared";
import { z } from "zod";
import { decodeAudio } from "../decode.ts";
import { createStereo, pcmLength, type StereoPcm, secToSamples } from "../pcm.ts";
import type {
  EnsureSfxVariantsFn,
  EpidemicRequestOptions,
  EpidemicSoundEffect,
  SfxVariantRequest,
} from "../provider.ts";
import { type SfxFile, variantLabel } from "../sfx.ts";
import { SfxQc } from "../sfxQc.ts";
import { encodeWav } from "../wav.ts";

/**
 * SFX з каталогу Epidemic Sound (B3): один пошук на cue за фразою з `prompts/epidemic/sfx-terms.md`,
 * варіант `k` — `k`-й кандидат пошуку; завантажуються лише запитані варіанти (що прозвучить, вирішує
 * стадія), у постійний кеш Epidemic (`ADC_EPIDEMIC_DIR`, не DATA_DIR прогону). Тиша на початку
 * прибирається, семпл обрізається до тривалості cue з fade-out і проходить той самий QC, що й ElevenLabs;
 * не пройшов (не лише через висоту тону) — один повтор наступним кандидатом, лишається кращий з двох
 * (подія не німіє). Режим «лише кеш» (`cacheOnly`) бере тільки вже завантажені семпли, без мережі.
 */

/** Назва файлу з пошуковими фразами: `prompts/epidemic/sfx-terms.md`. */
export const SFX_TERMS_PROMPT = "epidemic/sfx-terms";
/** Скільки кандидатів бере один пошук. */
export const EPIDEMIC_SFX_SEARCH_LIMIT = 30;
/** Довжина лінійного fade-out після обрізання до тривалості cue, мс. */
export const EPIDEMIC_SFX_FADE_MS = 30;
/** Модель у журналі витрат: семпл з каталогу (безкоштовний тариф — 0 $). */
export const EPIDEMIC_SFX_MODEL = "epidemic-catalog";
/** Найбільша довжина фрази кастомного cue. */
const CUSTOM_TERM_MAX = 120;

export type SfxTerms = Record<SoundCue, string>;

/** Рядок списку: `- whoosh: fast clean air whoosh transition`. */
const TERM_LINE = /^\s*[-*]\s*`?([a-z][a-z0-9-]*)`?\s*:\s*(.+?)\s*$/;

/** Фрази з тіла `sfx-terms.md`; кидає помилку, якщо якогось `SoundCue` немає або cue задано двічі. */
export function parseSfxTerms(body: string): SfxTerms {
  const found = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const m = TERM_LINE.exec(line);
    if (!m) continue;
    const [, cue, term] = m;
    if (!cue || !term) continue;
    if (found.has(cue)) throw new Error(`sfx-terms.md: cue ${cue} задано двічі`);
    found.set(cue, term);
  }
  const missing = SoundCue.options.filter((c) => !found.get(c));
  if (missing.length > 0) throw new Error(`sfx-terms.md: немає cue ${missing.join(", ")}`);
  return Object.fromEntries(SoundCue.options.map((c) => [c, found.get(c) as string])) as SfxTerms;
}

/** Фрази з дефолтної теки промптів (`loadPrompt`). */
export function loadSfxTerms(): SfxTerms {
  const p = loadPrompt(SFX_TERMS_PROMPT);
  return parseSfxTerms([p.system, p.user ?? ""].join("\n"));
}

/**
 * Фраза пошуку для запиту: `SoundCue` — з `sfx-terms.md`; кастомний cue (чи невідомий) — `def.text` до
 * першої коми, не довше 120 символів (тексти ElevenLabs довгі й містять технічні вимоги, каталогу зайві).
 */
export function epidemicSfxTerm(request: SfxVariantRequest, terms: SfxTerms | null): string {
  const known = SoundCue.safeParse(request.cue);
  if (!request.custom && known.success && terms) return terms[known.data];
  const text = request.def.text.trim();
  const head = (text.split(",")[0] ?? "").trim();
  return (head || text).slice(0, CUSTOM_TERM_MAX).trim();
}

/** Кандидати: спершу не довші за `max(2 × cue, 1.5)` с, усередині кожної групи — порядок best-match. */
export function orderSfxCandidates(
  found: readonly EpidemicSoundEffect[],
  durationSeconds: number,
): EpidemicSoundEffect[] {
  const limit = Math.max(2 * durationSeconds, 1.5);
  return [...found.filter((s) => s.length <= limit), ...found.filter((s) => !(s.length <= limit))];
}

/** Метадані семпла в кеші Epidemic: `sfx/<id>.json`. */
export const EpidemicSfxMeta = z.object({
  id: z.string(),
  title: z.string(),
  /** Тривалість за каталогом, с. */
  length: z.number(),
  /** Cue і фраза, з якими семпл завантажено вперше. */
  cue: z.string(),
  term: z.string(),
  /** QC останньої перевірки (після обрізання); null — без QC. */
  qc: SfxQc.nullable(),
});
export type EpidemicSfxMeta = z.infer<typeof EpidemicSfxMeta>;

const SearchCache = z.object({
  term: z.string(),
  soundEffects: z.array(z.object({ id: z.string(), title: z.string(), length: z.number() })),
});

const cacheKeys = {
  search: (term: string) => `sfx/search/${shortHash(term)}.json`,
  audio: (id: string) => `sfx/${id}.mp3`,
  meta: (id: string) => `sfx/${id}.json`,
};

/** Готовий WAV семпла у сховищі проєкту — `SfxFile.key`. */
export const epidemicSfxKey = (projectId: string, id: string) =>
  `${projectPaths(projectId).audioDir}/epidemic-sfx/${id}.wav`;

/** Поріг тиші на початку семпла: нижче за пік на стільки дБ — тиша. */
export const EPIDEMIC_SFX_SILENCE_DB = -40;
/** Скільки лишити перед першим звуком після обрізання тиші, мс. */
export const EPIDEMIC_SFX_PREROLL_MS = 5;

/**
 * Тиша на початку прибирається до QC і обрізання за тривалістю: у каталожних семплах вона буває до
 * секунди, і обрізання «від нуля» лишало б саму тишу (QC бачив тихий пік і пізній onset).
 */
export function trimLeadingSilence(
  pcm: StereoPcm,
  thresholdDb = EPIDEMIC_SFX_SILENCE_DB,
  prerollMs = EPIDEMIC_SFX_PREROLL_MS,
): StereoPcm {
  const len = pcmLength(pcm);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    peak = Math.max(peak, Math.abs(pcm.left[i] as number), Math.abs(pcm.right[i] as number));
  }
  if (peak === 0) return pcm;
  const threshold = peak * 10 ** (thresholdDb / 20);
  let first = 0;
  while (
    first < len &&
    Math.abs(pcm.left[first] as number) < threshold &&
    Math.abs(pcm.right[first] as number) < threshold
  ) {
    first++;
  }
  const start = Math.max(0, first - secToSamples(prerollMs / 1000, pcm.sampleRate));
  if (start === 0) return pcm;
  const out = createStereo(len - start, pcm.sampleRate);
  out.left.set(pcm.left.subarray(start));
  out.right.set(pcm.right.subarray(start));
  return out;
}

/**
 * Чи варто повторювати семпл, що не пройшов QC. Відсутність впевненої висоти тону — не привід
 * витрачати завантаження: тональність каталожних семплів не гарантована, а QC тут лише ранжує.
 */
export function worthRetry(qc: SfxQc): boolean {
  return !qc.ok && qc.reasons.some((r) => r !== "немає впевненої висоти тону");
}

/** Обрізання до `durationSeconds` з лінійним fade-out наприкінці; коротший — як є. */
export function trimWithFade(
  pcm: StereoPcm,
  durationSeconds: number,
  fadeMs = EPIDEMIC_SFX_FADE_MS,
): StereoPcm {
  const n = secToSamples(durationSeconds, pcm.sampleRate);
  if (pcmLength(pcm) <= n) return pcm;
  const out = createStereo(n, pcm.sampleRate);
  out.left.set(pcm.left.subarray(0, n));
  out.right.set(pcm.right.subarray(0, n));
  const fade = Math.min(n, Math.max(1, secToSamples(fadeMs / 1000, pcm.sampleRate)));
  for (let i = n - fade; i < n; i++) {
    // Останній семпл — рівно 0.
    const g = fade > 1 ? (n - 1 - i) / (fade - 1) : 0;
    out.left[i] = (out.left[i] as number) * g;
    out.right[i] = (out.right[i] as number) * g;
  }
  return out;
}

interface Prepared {
  sound: EpidemicSoundEffect;
  wav: Buffer;
  durationMs: number;
  qc: SfxQc | null;
  /** Чи було завантаження (не з кешу). */
  downloaded: boolean;
}

/**
 * Семпли Epidemic лише для запитаних варіантів (у порядку `requests`); cue без результатів пошуку —
 * немає в результаті (подія німіє, як при порожньому cue). Квота вичерпана — `EpidemicError` kind
 * "quota" до завантаження.
 */
export const ensureEpidemicSfxVariants: EnsureSfxVariantsFn = async (deps, requests) => {
  const ep = deps.epidemic;
  const logger: Logger = deps.logger ?? ep.logger ?? noopLogger;
  const signal = ep.signal ?? deps.signal;
  const opts = (s?: AbortSignal): EpidemicRequestOptions => (s ? { signal: s } : {});
  const terms = requests.some((r) => !r.custom && SoundCue.safeParse(r.cue).success) ? loadSfxTerms() : null;

  // Один пошук на фразу (= на cue): з кешу Epidemic, інакше запит і запис у кеш.
  const searches = new Map<string, Promise<EpidemicSoundEffect[]>>();
  const search = (cue: string, term: string): Promise<EpidemicSoundEffect[]> => {
    let pending = searches.get(term);
    if (!pending) {
      pending = (async () => {
        const key = cacheKeys.search(term);
        if (await ep.cache.exists(key)) {
          try {
            const cached = await ep.cache.readJson(key, (v) => SearchCache.parse(v));
            if (cached.term === term) return cached.soundEffects;
          } catch (err) {
            logger.warn("кеш пошуку Epidemic битий — шукаємо знову", { cue, err: String(err) });
          }
        }
        // Без кешу пошуку в кеші немає й семплів цього cue — запит не потрібен.
        if (ep.cacheOnly) return [];
        const found = await ep.gate.run(
          `sfx-search:${cue}`,
          (s) =>
            ep
              .client()
              .searchSoundEffects({ term, sort: "best-match", limit: EPIDEMIC_SFX_SEARCH_LIMIT }, opts(s)),
          signal,
        );
        const soundEffects = found.soundEffects.map(({ id, title, length }) => ({ id, title, length }));
        await ep.cache.writeJson(key, { term, soundEffects });
        return soundEffects;
      })();
      searches.set(term, pending);
    }
    return pending;
  };

  const readMeta = async (id: string): Promise<EpidemicSfxMeta | null> => {
    try {
      if (!(await ep.cache.exists(cacheKeys.meta(id)))) return null;
      return await ep.cache.readJson(cacheKeys.meta(id), (v) => EpidemicSfxMeta.parse(v));
    } catch {
      return null;
    }
  };

  /** Сирий файл з кешу або завантаження (квота → URL → байти → кеш → витрати). */
  const fetchRaw = async (
    sound: EpidemicSoundEffect,
    label: string,
    cue: string,
    term: string,
  ): Promise<{ bytes: Buffer; downloaded: boolean }> => {
    const key = cacheKeys.audio(sound.id);
    if (await ep.cache.exists(key)) return { bytes: await ep.cache.read(key), downloaded: false };
    await ep.quota.consume("sfx", sound.id, label);
    const { url } = await ep.gate.run(
      `sfx-download:${label}`,
      (s) => ep.client().soundEffectDownloadUrl(sound.id, { quality: "normal" }, opts(s)),
      signal,
    );
    const bytes = await ep.gate.run(
      `sfx-fetch:${label}`,
      (s) => ep.client().fetchBytes(url, opts(s)),
      signal,
    );
    await ep.cache.write(key, bytes);
    const meta: EpidemicSfxMeta = {
      id: sound.id,
      title: sound.title,
      length: sound.length,
      cue,
      term,
      qc: null,
    };
    await ep.cache.writeJson(cacheKeys.meta(sound.id), meta);
    try {
      await deps.cost.record({
        provider: "epidemic",
        kind: "sfx",
        model: EPIDEMIC_SFX_MODEL,
        seconds: sound.length,
        detail: `sfx:${label}:${sound.id}`,
      });
    } catch (err) {
      logger.error("не вдалося записати витрати SFX Epidemic", { cue, id: sound.id, err: String(err) });
    }
    return { bytes, downloaded: true };
  };

  /** Кандидат → обрізаний WAV + QC (результат QC — у meta кешу). */
  const prepare = async (
    sound: EpidemicSoundEffect,
    request: SfxVariantRequest,
    term: string,
  ): Promise<Prepared> => {
    const label = variantLabel(request.cue, request.variant);
    const { bytes, downloaded } = await fetchRaw(sound, label, request.cue, term);
    const decoded = await decodeAudio(bytes, signal ? { signal } : {});
    const pcm = trimWithFade(trimLeadingSilence(decoded), request.def.durationSeconds);
    const wav = encodeWav(pcm);
    const durationMs = Math.round((pcmLength(pcm) / pcm.sampleRate) * 1000);
    let qc: SfxQc | null = null;
    if (deps.qc) {
      try {
        qc = await deps.qc(wav, request.cue, request.def, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        logger.warn("QC семпла Epidemic не вдався — без перевірки", { cue: request.cue, err: String(err) });
      }
    }
    if (qc) {
      const meta = (await readMeta(sound.id)) ?? {
        id: sound.id,
        title: sound.title,
        length: sound.length,
        cue: request.cue,
        term,
        qc: null,
      };
      if (JSON.stringify(meta.qc) !== JSON.stringify(qc)) {
        await ep.cache.writeJson(cacheKeys.meta(sound.id), { ...meta, qc });
      }
    }
    return { sound, wav, durationMs, qc, downloaded };
  };

  // Кандидати кожного запиту — до завантажень: повтор не бере основного кандидата іншого варіанта.
  const planned: Array<{ request: SfxVariantRequest; term: string; ordered: EpidemicSoundEffect[] }> = [];
  for (const request of requests) {
    const term = epidemicSfxTerm(request, terms);
    let ordered = orderSfxCandidates(await search(request.cue, term), request.def.durationSeconds);
    if (ep.cacheOnly) {
      // Лише вже завантажені кандидати: варіант `k` — `k`-й з них.
      const cached = await Promise.all(ordered.map((s) => ep.cache.exists(cacheKeys.audio(s.id))));
      ordered = ordered.filter((_, i) => cached[i]);
    }
    planned.push({ request, term, ordered });
  }
  /** Варіант `k` — кандидат `(k − 1) mod n`. */
  const startOf = (n: number, variant: number) => (((variant - 1) % n) + n) % n;
  const primaries = new Map<string, Set<string>>();
  for (const { request, ordered } of planned) {
    if (ordered.length === 0) continue;
    const ids = primaries.get(request.cue) ?? new Set<string>();
    ids.add((ordered[startOf(ordered.length, request.variant)] as EpidemicSoundEffect).id);
    primaries.set(request.cue, ids);
  }

  const out: Awaited<ReturnType<EnsureSfxVariantsFn>> = [];
  for (const { request, term, ordered } of planned) {
    const { cue, variant } = request;
    if (ordered.length === 0) {
      logger.warn(
        ep.cacheOnly
          ? "Epidemic: у кеші немає семплів cue (режим «лише кеш») — подія без звуку"
          : "Epidemic: немає семплів за фразою — подія без звуку",
        { cue, variant, term },
      );
      continue;
    }
    const start = startOf(ordered.length, variant);
    const primary = ordered[start] as EpidemicSoundEffect;
    let best = await prepare(primary, request, term);
    let downloaded = best.downloaded;
    if (best.qc && worthRetry(best.qc)) {
      // Наступний кандидат, не основний для інших запитаних варіантів cue (якщо такого немає — будь-який).
      const rest = Array.from(
        { length: ordered.length - 1 },
        (_, i) => ordered[(start + 1 + i) % ordered.length],
      ).filter((s): s is EpidemicSoundEffect => s !== undefined && s.id !== primary.id);
      const taken = primaries.get(cue) ?? new Set<string>();
      const retry = rest.find((s) => !taken.has(s.id)) ?? rest[0];
      if (retry) {
        logger.warn("семпл Epidemic не пройшов QC — повтор наступним кандидатом", {
          cue,
          variant,
          id: primary.id,
          reasons: best.qc.reasons,
          retry: retry.id,
        });
        const second = await prepare(retry, request, term);
        downloaded ||= second.downloaded;
        if (second.qc && second.qc.reasons.length < best.qc.reasons.length) best = second;
      }
    }
    const key = epidemicSfxKey(deps.projectId, best.sound.id);
    await deps.storage.write(key, best.wav);
    const file: SfxFile = {
      cue,
      key,
      hash: `ep-${best.sound.id}`,
      durationMs: best.durationMs,
      generated: downloaded,
      qcOk: best.qc ? best.qc.ok : null,
    };
    out.push({ cue, variant, file, epidemicId: best.sound.id, title: best.sound.title });
  }
  return out;
};
