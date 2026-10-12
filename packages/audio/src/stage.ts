import {
  AudioManifest,
  AudioPlan,
  BrandKit,
  type CostRecorder,
  computeEventPlacements,
  createCostRecorder,
  loadPrices,
  MusicMeta,
  ProjectState,
  projectPaths,
  type SoundCue,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  Storyboard,
  t,
} from "@adc/shared";
import { computeChunkLayout } from "./chunks.ts";
import { createElevenLabsClient, type ElevenLabsLike } from "./client.ts";
import { PUBLIC_MIX_FILE, PUBLIC_MUSIC_FILE, publicSfxFile } from "./constants.ts";
import { type DecodeAudio, decodeAudio } from "./decode.ts";
import { defaultGate, type ElevenLabsGate } from "./gate.ts";
import { buildAudioManifest } from "./manifest.ts";
import { renderSoundtrack, soundtrackHash } from "./mixer.ts";
import { ensureMusic } from "./music.ts";
import { gainToDb } from "./pcm.ts";
import {
  AUDIO_PLAN_PROMPT,
  AudioPlanDraft,
  audioPlanVars,
  isStandardCue,
  musicBriefHash,
  normalizeAudioPlan,
  planCoversCues,
  planMatchesLayout,
  referencedCues,
} from "./plan.ts";
import type { SfxSample } from "./samples.ts";
import { brandTerms, createSanitizer } from "./sanitize.ts";
import {
  type CueDefinition,
  ensureCustomSfx,
  ensureStandardSfx,
  loadSfxLibrary,
  loadStandardCues,
  type SfxDeps,
  type SfxFile,
  sfxHash,
  variantLabel,
} from "./sfx.ts";

export interface AudioStageDeps {
  /** Клієнт ElevenLabs або фабрика (створюється ліниво — лише якщо потрібен платний виклик). */
  client?: ElevenLabsLike | (() => ElevenLabsLike);
  /** Черга/повтори; дефолт — спільна черга процесу. */
  gate?: ElevenLabsGate;
  /** Журнал спільних витрат (догенерація стандартних SFX, якщо кеш не прогріто). */
  sharedCost?: CostRecorder | ((ctx: StageContext<"audio">) => CostRecorder);
  /** Декодер музики і семплів SFX у PCM для зведення; дефолт — ffmpeg зі збірки Remotion. */
  decode?: DecodeAudio;
  now?: () => Date;
}

/** Ключ кешу зведення: поруч із треком, `audio/<planHash>/mix-<hash>.wav`. */
export function soundtrackCacheKey(projectId: string, planHash: string, mixHash: string): string {
  return `${projectPaths(projectId).audioDir}/${planHash}/mix-${mixHash}.wav`;
}

async function readOptional<T>(storage: Storage, key: string, parse: (v: unknown) => T): Promise<T | null> {
  try {
    if (!(await storage.exists(key))) return null;
    return await storage.readJson(key, parse);
  } catch {
    return null;
  }
}

async function readBrandKit(
  storage: Storage,
  projectId: string,
  version: number | null,
): Promise<BrandKit | null> {
  const paths = projectPaths(projectId);
  let v = version;
  if (v === null) {
    // project.json ще не знає версію — беремо найновішу brandkit/v<k>.json.
    const versions = (await storage.list(paths.brandkitDir))
      .map((k) => /\/v(\d+)\.json$/.exec(k)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    v = versions.length > 0 ? Math.max(...versions) : null;
  }
  if (v === null) return null;
  return readOptional(storage, paths.brandkit(v), (x) => BrandKit.parse(x));
}

interface PreviousMusic {
  rev: number | null;
  meta: MusicMeta;
  key: string;
}

/** Трек, що використовується зараз (project.audioPlanHash або audio.json ревізії-основи). */
async function findPreviousMusic(
  storage: Storage,
  projectId: string,
  rev: number,
  project: ProjectState | null,
): Promise<PreviousMusic | null> {
  const paths = projectPaths(projectId);
  const baseRev = project?.revisions.find((r) => r.n === rev)?.basedOn ?? (rev > 1 ? rev - 1 : null);
  let planHash = project?.audioPlanHash ?? null;
  if (!planHash && baseRev !== null) {
    const manifest = await readOptional(storage, paths.rev(baseRev).audio, (v) => AudioManifest.parse(v));
    planHash = manifest?.music?.planHash ?? null;
  }
  if (!planHash) return null;
  const key = paths.music(planHash);
  if (!(await storage.exists(key))) return null;
  const meta = await readOptional(storage, paths.musicMeta(planHash), (v) => MusicMeta.parse(v));
  return meta ? { rev: baseRev, meta, key } : null;
}

/**
 * Правило повторного використання треку при правках: музичний бриф не змінився і нове відео
 * не довше за наявний трек → трек лишається (хост підрізає його з fade-out). Інакше — новий.
 */
export function canReuseMusic(
  prev: Pick<MusicMeta, "briefHash" | "durationMs">,
  briefHash: string,
  videoMs: number,
) {
  return prev.briefHash === briefHash && videoMs <= prev.durationMs;
}

export function createAudioStage(deps: AudioStageDeps = {}): Stage<"audio"> {
  return async (ctx) => {
    const { storage, projectId, rev, logger } = ctx;
    const paths = projectPaths(projectId);
    const revPaths = paths.rev(rev);
    const now = deps.now ?? (() => new Date());

    try {
      await ctx.emit.progress("audio", t("audioProgress"));
    } catch (err) {
      logger.warn("не вдалося надіслати прогрес", { err: String(err) });
    }

    const storyboard = await readOptional(storage, revPaths.storyboard, (v) => Storyboard.parse(v));
    if (!storyboard) {
      throw new StageError(
        `audio: немає ${revPaths.storyboard}`,
        "audio_inputs_missing",
        "Немає розкадровки для музики.",
        false,
      );
    }
    const project = await readOptional(storage, paths.project, (v) => ProjectState.parse(v));
    const brand = await readBrandKit(storage, projectId, project?.brandkitVersion ?? null);
    if (!brand) {
      throw new StageError(
        "audio: немає бренд-кіта",
        "audio_inputs_missing",
        "Немає бренд-кіта для музики.",
        false,
      );
    }

    const layout = computeChunkLayout(storyboard);
    const sanitizer = createSanitizer(brandTerms(brand));
    const standardCues = loadStandardCues(ctx.prompts);
    const sfxLibrary = loadSfxLibrary(ctx.prompts);
    const briefHash = musicBriefHash(storyboard.musicBrief);

    // Лінива фабрика клієнта: якщо все з кешу — ключ API не потрібен.
    let client: ElevenLabsLike | null = null;
    const getClient = () => {
      if (!client) {
        if (typeof deps.client === "function") client = deps.client();
        else if (deps.client) client = deps.client;
        else {
          try {
            client = createElevenLabsClient();
          } catch (err) {
            throw new StageError(
              `audio: ${(err as Error).message}`,
              "elevenlabs_not_configured",
              "Сервіс музики не налаштовано.",
              false,
              { cause: err },
            );
          }
        }
      }
      return client;
    };
    const gate = deps.gate ?? defaultGate(logger);

    // Повторне використання треку попередньої ревізії.
    const prev = await findPreviousMusic(storage, projectId, rev, project);
    const reuse = prev !== null && canReuseMusic(prev.meta, briefHash, layout.videoMs);

    // План: збережений у цій ревізії (повтор стадії) → план основи (якщо трек лишається) → LLM.
    let plan = await readOptional(storage, revPaths.audioPlan, (v) => AudioPlan.parse(v));
    if (plan && !planMatchesLayout(plan, layout, storyboard)) plan = null;
    if (!plan && reuse && prev.rev !== null) {
      const basePlan = await readOptional(storage, paths.rev(prev.rev).audioPlan, (v) => AudioPlan.parse(v));
      if (basePlan && planCoversCues(basePlan, storyboard)) plan = basePlan;
    }
    if (!plan) {
      const res = await ctx.llm.structured(
        AUDIO_PLAN_PROMPT,
        audioPlanVars(brand, storyboard, layout, sanitizer),
        AudioPlanDraft,
        ctx.signal ? { signal: ctx.signal } : {},
      );
      plan = normalizeAudioPlan(res.data, { layout, storyboard, sanitizer, standardCues });
    }
    await storage.writeJson(revPaths.audioPlan, plan);
    const artifacts: string[] = [revPaths.audioPlan];

    const musicDeps = {
      storage,
      client: getClient,
      gate,
      cost: ctx.cost,
      logger,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      now,
    };

    const musicPromise = (async () => {
      if (reuse) {
        logger.info("трек попередньої ревізії лишається", { planHash: prev.meta.planHash });
        return { planHash: prev.meta.planHash, key: prev.key, meta: prev.meta, reused: true };
      }
      try {
        const m = await ensureMusic(musicDeps, projectId, plan, briefHash);
        return { ...m, reused: m.cached && m.planHash === prev?.meta.planHash };
      } catch (err) {
        if (err instanceof StageError) throw err;
        throw new StageError(
          `audio: музика не згенерувалась: ${(err as Error).message}`,
          "music_failed",
          "Не вдалося створити музику. Спробуйте ще раз.",
          true,
          { cause: err },
        );
      }
    })();

    const sfxDeps: SfxDeps = {
      storage,
      client: getClient,
      gate,
      logger,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      now,
    };
    let sharedCost: CostRecorder | null = null;
    const getSharedCost = (): CostRecorder => {
      if (!sharedCost) {
        if (typeof deps.sharedCost === "function") sharedCost = deps.sharedCost(ctx);
        else if (deps.sharedCost) sharedCost = deps.sharedCost;
        else
          sharedCost = createCostRecorder(storage, loadPrices(), {
            projectId: null,
            rev: null,
            stage: "sfx-cache",
            phase: ctx.phase,
            source: ctx.source,
            attempt: 1,
          });
      }
      return sharedCost;
    };

    // Спільний кеш SFX: один запит (хеш) — один виклик, навіть якщо його чекають і legacy-шлях, і події.
    const sharedJobs = new Map<string, Promise<SfxFile>>();
    const ensureShared = (label: string, def: CueDefinition): Promise<SfxFile> => {
      const hash = sfxHash(def);
      let job = sharedJobs.get(hash);
      if (!job) {
        job = ensureStandardSfx(sfxDeps, getSharedCost, label, def);
        sharedJobs.set(hash, job);
      }
      return job;
    };

    // Legacy `scene.sfxCue`: файли в public, хост грає їх, коли зведення немає.
    const cues = referencedCues(storyboard);
    const sfxJobs: Array<Promise<SfxFile>> = [];
    for (const cue of [...cues.standard, ...cues.custom]) {
      const spec = plan.sfx.find((s) => s.cue === cue);
      if (isStandardCue(cue)) {
        const def = standardCues[cue as keyof typeof standardCues];
        sfxJobs.push(ensureShared(variantLabel(cue, 1), def).then((f) => ({ ...f, cue })));
      } else if (spec?.custom) {
        sfxJobs.push(
          ensureCustomSfx(sfxDeps, ctx.cost, projectId, cue, {
            text: spec.text,
            durationSeconds: spec.durationSeconds,
          }),
        );
      } else {
        logger.warn("SFX-cue без опису в аудіо-плані — пропускаємо", { cue });
      }
    }

    // Звуки подій: усі варіанти cue, використаних подіями (спільний кеш; промах — генерація).
    const eventCues = [
      ...new Set(
        computeEventPlacements(storyboard)
          .map((p) => p.cue)
          .filter((c): c is SoundCue => c !== null),
      ),
    ];
    const variantJobs = eventCues.flatMap((cue) =>
      sfxLibrary[cue].map((def, i) => {
        const variant = i + 1;
        return ensureShared(variantLabel(cue, variant), def).then((file) => ({ cue, variant, file }));
      }),
    );

    const [music, sfxResults, variantResults] = await Promise.all([
      musicPromise,
      Promise.allSettled(sfxJobs),
      Promise.allSettled(variantJobs),
    ]);
    const sfxFiles: SfxFile[] = [];
    for (const r of sfxResults) {
      if (r.status === "fulfilled") sfxFiles.push(r.value);
      else logger.warn("SFX не згенерувався — сцена буде без нього", { err: String(r.reason) });
    }
    const variantFiles: Array<{ cue: SoundCue; variant: number; file: SfxFile }> = [];
    for (const r of variantResults) {
      if (r.status === "fulfilled") variantFiles.push(r.value);
      else logger.warn("варіант SFX не згенерувався — пропускаємо", { err: String(r.reason) });
    }

    // Файли для staticFile() хоста.
    const musicPublic = revPaths.publicFile(PUBLIC_MUSIC_FILE);
    await storage.copy(music.key, musicPublic);
    artifacts.push(musicPublic);
    for (const f of sfxFiles) {
      const dest = revPaths.publicFile(publicSfxFile(f.cue));
      await storage.copy(f.key, dest);
      artifacts.push(dest);
    }

    // Зведення: трек + семпли бібліотеки SFX за таймлайном подій + дакінг + мастер → soundtrack.wav.
    // Кеш — за planHash + тональністю + таймлайном + подіями + хешами варіантів семплів;
    // без зведення хост грає music і sfx, як раніше.
    let mix: { durationMs: number } | null = null;
    try {
      const decode = deps.decode ?? decodeAudio;
      const decodeOpts = ctx.signal ? { signal: ctx.signal } : {};
      const hashesOf = (files: ReadonlyArray<{ cue: SoundCue; file: SfxFile }>) => {
        const out: Partial<Record<SoundCue, string[]>> = {};
        for (const f of files) out[f.cue] = [...(out[f.cue] ?? []), f.file.hash];
        return out;
      };
      let mixHash = soundtrackHash({
        planHash: music.planHash,
        key: plan.key,
        storyboard,
        samples: hashesOf(variantFiles),
      });
      let mixKey = soundtrackCacheKey(projectId, music.planHash, mixHash);
      if (!(await storage.exists(mixKey))) {
        const pcm = await decode(await storage.read(music.key), decodeOpts);
        // Семпли: помилка декодування варіанта — пропуск варіанта; cue без варіантів — події без звуку.
        const decoded = await Promise.allSettled(
          variantFiles.map(async (v) => ({
            ...v,
            pcm: await decode(await storage.read(v.file.key), decodeOpts),
          })),
        );
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("aborted");
        const samples: Partial<Record<SoundCue, SfxSample[]>> = {};
        const used: Array<{ cue: SoundCue; file: SfxFile }> = [];
        decoded.forEach((r, i) => {
          const v = variantFiles[i];
          if (!v) return;
          if (r.status === "rejected") {
            logger.warn("семпл SFX не декодувався — пропускаємо варіант", {
              cue: v.cue,
              variant: v.variant,
              err: String(r.reason),
            });
            return;
          }
          const sample: SfxSample = { cue: v.cue, variant: v.variant, hash: v.file.hash, pcm: r.value.pcm };
          samples[v.cue] = [...(samples[v.cue] ?? []), sample];
          used.push(v);
        });
        for (const cue of eventCues) {
          if (!samples[cue]?.length) logger.warn("немає жодного семпла cue — події без звуку", { cue });
        }
        // Хеш — за фактично використаними семплами: наступний прогін повторить пропущені.
        mixHash = soundtrackHash({
          planHash: music.planHash,
          key: plan.key,
          storyboard,
          samples: hashesOf(used),
        });
        mixKey = soundtrackCacheKey(projectId, music.planHash, mixHash);
        const soundtrack = renderSoundtrack({ music: pcm, storyboard, key: plan.key, samples });
        logger.info("зведення готове", {
          mixHash,
          events: soundtrack.sounds.length,
          silentEvents: soundtrack.silent.length,
          samples: used.length,
          beatShiftMs: soundtrack.alignment
            ? Math.round((soundtrack.alignment.shiftSamples / pcm.sampleRate) * 1000)
            : null,
          beatConfidence: soundtrack.alignment
            ? Math.round(soundtrack.alignment.confidence * 100) / 100
            : null,
          masterGainDb: Math.round(gainToDb(soundtrack.masterGain) * 10) / 10,
        });
        await storage.write(mixKey, soundtrack.wav);
      }
      const mixPublic = revPaths.publicFile(PUBLIC_MIX_FILE);
      await storage.copy(mixKey, mixPublic);
      artifacts.push(mixPublic);
      mix = { durationMs: layout.videoMs };
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      logger.error("зведення не вдалося — хост гратиме музику і SFX окремо", { err: String(err) });
    }

    const manifest = AudioManifest.parse(
      buildAudioManifest({
        storyboard,
        music: { planHash: music.planHash, durationMs: music.meta.durationMs },
        sfx: sfxFiles.map((f) => ({ cue: f.cue, durationMs: f.durationMs })),
        mix,
      }),
    );
    await storage.writeJson(revPaths.audio, manifest);
    artifacts.push(revPaths.audio);

    return {
      artifacts,
      outputs: { planHash: music.planHash, reusedMusic: music.reused },
    };
  };
}

/** Стадія `audio` з дефолтними залежностями (справжній ElevenLabs із env, спільна черга). */
export const audioStage: Stage<"audio"> = createAudioStage();
