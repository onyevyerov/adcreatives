import {
  AudioManifest,
  AudioPlan,
  type AudioProvider,
  applySfxPlan,
  BrandKit,
  type CostRecorder,
  computeEventPlacements,
  createCostRecorder,
  LocalStorage,
  loadPrices,
  MusicMeta,
  ProjectState,
  projectPaths,
  readTuning,
  SfxPlan,
  SoundCue,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  Storyboard,
  t,
} from "@adc/shared";
import { z } from "zod";
import { computeChunkLayout } from "./chunks.ts";
import { createElevenLabsClient, type ElevenLabsLike } from "./client.ts";
import { PUBLIC_MIX_FILE, publicMusicFile, publicSfxFile } from "./constants.ts";
import { type DecodeAudio, decodeAudio } from "./decode.ts";
import { createEpidemicClient } from "./epidemic/client.ts";
import { classifyEpidemicError } from "./epidemic/errors.ts";
import { defaultEpidemicGate, type EpidemicGate } from "./epidemic/gate.ts";
import { ensureEpidemicMusic } from "./epidemic/music.ts";
import { createEpidemicQuota, epidemicDir } from "./epidemic/quota.ts";
import { ensureEpidemicSfxVariants } from "./epidemic/sfx.ts";
import { defaultGate, type ElevenLabsGate } from "./gate.ts";
import { resolveEventKey } from "./keyDetect.ts";
import { buildAudioManifest } from "./manifest.ts";
import { renderSoundtrack, soundtrackHash } from "./mixer.ts";
import { ensureMusic, musicRawWavKey, musicWavKey } from "./music.ts";
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
import {
  type EnsureMusicFn,
  type EnsureSfxVariantsFn,
  type EpidemicDeps,
  EpidemicError,
  type EpidemicLike,
  type EpidemicQuota,
  type SfxVariantRequest,
} from "./provider.ts";
import type { SfxSample } from "./samples.ts";
import { brandTerms, createSanitizer } from "./sanitize.ts";
import {
  type CueDefinition,
  dropFailedQc,
  ensureCustomSfx,
  ensureStandardSfx,
  loadSfxLibrary,
  loadStandardCues,
  type SfxDeps,
  type SfxFile,
  sfxHash,
  variantLabel,
} from "./sfx.ts";
import { defaultSfxQc, type SfxQcHook } from "./sfxQc.ts";
import { buildSoundSheet, MixFacts, mixFacts } from "./soundSheet.ts";
import { variantIndices } from "./variants.ts";

export interface AudioStageDeps {
  /** Клієнт ElevenLabs або фабрика (створюється ліниво — лише якщо потрібен платний виклик). */
  client?: ElevenLabsLike | (() => ElevenLabsLike);
  /** Черга/повтори; дефолт — спільна черга процесу. */
  gate?: ElevenLabsGate;
  /** Журнал спільних витрат (догенерація стандартних SFX, якщо кеш не прогріто). */
  sharedCost?: CostRecorder | ((ctx: StageContext<"audio">) => CostRecorder);
  /** Декодер музики і семплів SFX у PCM для зведення; дефолт — ffmpeg зі збірки Remotion. */
  decode?: DecodeAudio;
  /** QC щойно згенерованих семплів SFX; дефолт — `defaultSfxQc`. */
  qc?: SfxQcHook;
  now?: () => Date;
  /** Клієнт Epidemic Sound або фабрика; дефолт — `createEpidemicClient()` з `EPIDEMIC_API_KEY`. */
  epidemicClient?: EpidemicLike | (() => EpidemicLike);
  /** Лічильник завантажень Epidemic; дефолт — `downloads.json` у `epidemicDir()`. */
  epidemicQuota?: EpidemicQuota;
  /** Постійний кеш завантажень Epidemic; дефолт — `LocalStorage(epidemicDir())`. */
  epidemicCache?: Storage;
  /** Черга викликів Epidemic; дефолт — спільна черга процесу. */
  epidemicGate?: EpidemicGate;
  /** Точки підміни провайдерів музики (тести); дефолт — `ensureMusic` / `ensureEpidemicMusic`. */
  ensureMusicBy?: Partial<Record<AudioProvider, EnsureMusicFn>>;
  /** Точка підміни SFX Epidemic (тести); дефолт — `ensureEpidemicSfxVariants`. */
  ensureSfxVariantsBy?: Partial<Record<"epidemic", EnsureSfxVariantsFn>>;
}

/**
 * Скільки варіантів cue стадія вважає доступними в Epidemic (як 5 варіантів бібліотеки ElevenLabs):
 * ротація `variantIndices` вирішує, які з них реально прозвучать, — лише їх і просимо.
 */
const EPIDEMIC_SFX_POOL = 5;

const EPIDEMIC_NOT_CONFIGURED = "Сервіс Epidemic Sound не налаштовано.";

/** Перша `EpidemicError` у ланцюжку `cause` (провайдер може загорнути помилку клієнта). */
function findEpidemicError(err: unknown): EpidemicError | null {
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i++) {
    if (e instanceof EpidemicError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Помилки Epidemic, які не можна повторювати: квота (поріг завантажень) і відсутній/невалідний ключ.
 * Решта — null (вирішує виклик: музика → `music_failed`, SFX → попередження).
 */
function epidemicStageError(err: unknown): StageError | null {
  const { kind } = classifyEpidemicError(err);
  if (kind === "quota") {
    const message = findEpidemicError(err)?.message ?? String((err as Error)?.message ?? err);
    return new StageError(`audio: ${message}`, "epidemic_quota", message, false, { cause: err });
  }
  if (kind === "unauthorized") {
    return new StageError(
      `audio: ${String((err as Error)?.message ?? err)}`,
      "epidemic_not_configured",
      EPIDEMIC_NOT_CONFIGURED,
      false,
      { cause: err },
    );
  }
  return null;
}

/** Ключ кешу зведення: поруч із треком, `audio/<planHash>/mix-<hash>.wav`. */
export function soundtrackCacheKey(projectId: string, planHash: string, mixHash: string): string {
  return `${projectPaths(projectId).audioDir}/${planHash}/mix-${mixHash}.wav`;
}

/** Заміри мастера кешованого зведення: `mix-<hash>.json` поруч із WAV. */
export const MixMasterMeta = z.object({
  integratedLufs: z.number().nullable(),
  truePeakDbtp: z.number().nullable(),
  masterGainDb: z.number().nullable(),
  /** Факти зведення для звукової відомості; null — кеш старший за відомість (зведення повторюється). */
  facts: MixFacts.nullable().default(null),
});
export type MixMasterMeta = z.infer<typeof MixMasterMeta>;

export const mixMasterMetaKey = (mixKey: string) => mixKey.replace(/\.wav$/, ".json");

const round1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

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

/**
 * Трек, що використовується зараз (project.audioPlanHash або audio.json ревізії-основи):
 * обрізаний `music.wav`, якщо він є і трек перевірено (`check`), інакше сирий `music.mp3`.
 */
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
  const meta = await readOptional(storage, paths.musicMeta(planHash), (v) => MusicMeta.parse(v));
  if (!meta) return null;
  const wavKey = musicWavKey(projectId, planHash);
  if (meta.check !== null && (await storage.exists(wavKey))) return { rev: baseRev, meta, key: wavKey };
  // Сирий трек: `music.mp3`, а для PCM-формату — `music-raw.wav` (A1).
  for (const rawKey of [paths.music(planHash), musicRawWavKey(projectId, planHash)]) {
    if (await storage.exists(rawKey)) return { rev: baseRev, meta, key: rawKey };
  }
  return null;
}

/**
 * Правило повторного використання треку при правках: музичний бриф не змінився і нове відео
 * не довше за наявний трек → трек лишається (хост підрізає його з fade-out). Інакше — новий.
 */
export function canReuseMusic(
  prev: Pick<MusicMeta, "briefHash" | "durationMs"> & { provider?: AudioProvider },
  briefHash: string,
  videoMs: number,
  provider: AudioProvider = "elevenlabs",
) {
  // Лише трек того самого провайдера (старий music.json без поля — ElevenLabs): прогін з іншим
  // провайдером не підхоплює трек попереднього ні через audioPlanHash, ні через audio.json основи.
  return (
    (prev.provider ?? "elevenlabs") === provider && prev.briefHash === briefHash && videoMs <= prev.durationMs
  );
}

/** Cue, які звучать у подіях розкадровки. */
function eventCuesOf(storyboard: Storyboard): SoundCue[] {
  return [
    ...new Set(
      computeEventPlacements(storyboard)
        .map((p) => p.cue)
        .filter((c): c is SoundCue => c !== null),
    ),
  ];
}

interface VariantFile {
  cue: SoundCue;
  variant: number;
  file: SfxFile;
}

type MixManifestInput = { durationMs: number } & Omit<MixMasterMeta, "facts">;

/** SFX ревізії від Epidemic: семпли подій, legacy-файли і що взято з каталогу. */
interface EpidemicSfxResult {
  variantFiles: VariantFile[];
  legacyFiles: SfxFile[];
  picked: Array<{ cue: string; variant: number; id: string; title: string }>;
  /** Семплів, завантажених цим викликом (не з кешу). */
  downloads: number;
}

/** SFX фази: legacy-файли для public, семпли для зведення і (для Epidemic) що взято з каталогу. */
interface StageSfx {
  sfxFiles: SfxFile[];
  variantFiles: VariantFile[];
  epidemic: EpidemicSfxResult | null;
}

/**
 * Стадія `audio` у трьох фазах (`params.phase`):
 * - `music` — план, трек, прогрів усіх варіантів бібліотеки SFX; `audio.json` з `mix: null`, без зведення;
 * - `mix` — зведення треку цієї ревізії за розкадровкою з накладеним `sfx-plan.json` + `sound-sheet.json`;
 * - `full` (або без поля) — усе разом, як до звукорежисера (план SFX накладається, якщо він є).
 */
export function createAudioStage(deps: AudioStageDeps = {}): Stage<"audio"> {
  return async (ctx) => {
    const { storage, projectId, rev, logger } = ctx;
    const paths = projectPaths(projectId);
    const revPaths = paths.rev(rev);
    const now = deps.now ?? (() => new Date());
    const phase = ctx.params.phase ?? "full";
    // Провайдери: параметри job (фіксуються на ревізію) → перемикачі з env.
    const tuning =
      ctx.params.musicProvider !== undefined && ctx.params.sfxProvider !== undefined ? null : readTuning();
    const musicProvider: AudioProvider = ctx.params.musicProvider ?? tuning?.musicProvider ?? "elevenlabs";
    const sfxProvider: AudioProvider = ctx.params.sfxProvider ?? tuning?.sfxProvider ?? "elevenlabs";
    logger.info("провайдери звуку", { phase, musicProvider, sfxProvider });

    try {
      await ctx.emit.progress("audio", t("audioProgress"));
    } catch (err) {
      logger.warn("не вдалося надіслати прогрес", { err: String(err) });
    }

    // Розкадровка режисера (звук подій — чернетка); музика, план і legacy-SFX рахуються за нею.
    const draft = await readOptional(storage, revPaths.storyboard, (v) => Storyboard.parse(v));
    if (!draft) {
      throw new StageError(
        `audio: немає ${revPaths.storyboard}`,
        "audio_inputs_missing",
        "Немає розкадровки для музики.",
        false,
      );
    }
    // План звукорежисера підміняє лише `events[].sound`; зведення і відомість — за ефективною розкадровкою.
    const sfxPlan =
      phase === "music" ? null : await readOptional(storage, revPaths.sfxPlan, (v) => SfxPlan.parse(v));
    const applied = applySfxPlan(draft, sfxPlan);
    if (sfxPlan) logger.info("план SFX накладено", { applied: applied.applied });
    if (applied.dropped.length > 0) {
      logger.warn("рішення плану SFX без події в розкадровці — пропущено", {
        dropped: applied.dropped.map((d) => `${d.sceneId}/${d.eventId}`),
      });
    }
    const storyboard = applied.storyboard;
    const project = await readOptional(storage, paths.project, (v) => ProjectState.parse(v));
    const layout = computeChunkLayout(draft);
    const sfxLibrary = loadSfxLibrary(ctx.prompts);

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
    const decode = deps.decode ?? decodeAudio;

    // Epidemic: клієнт створюється ліниво; без ключа — зрозуміла помилка, не повторюється.
    let epidemicClient: EpidemicLike | null = null;
    const getEpidemicClient = (): EpidemicLike => {
      if (!epidemicClient) {
        if (typeof deps.epidemicClient === "function") epidemicClient = deps.epidemicClient();
        else if (deps.epidemicClient) epidemicClient = deps.epidemicClient;
        else {
          try {
            epidemicClient = createEpidemicClient();
          } catch (err) {
            throw new StageError(
              `audio: ${(err as Error).message}`,
              "epidemic_not_configured",
              EPIDEMIC_NOT_CONFIGURED,
              false,
              { cause: err },
            );
          }
        }
      }
      return epidemicClient;
    };
    let epidemicDeps: EpidemicDeps | null = null;
    const getEpidemicDeps = (): EpidemicDeps => {
      if (!epidemicDeps) {
        let dir: string | null = null;
        const dirOf = () => {
          dir ??= epidemicDir();
          return dir;
        };
        epidemicDeps = {
          client: getEpidemicClient,
          quota: deps.epidemicQuota ?? createEpidemicQuota(dirOf()),
          cache: deps.epidemicCache ?? new LocalStorage(dirOf()),
          gate: deps.epidemicGate ?? defaultEpidemicGate(logger),
          logger,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          now,
        };
      }
      return epidemicDeps;
    };
    // Epidemic потрібен цій фазі → ключ перевіряється до будь-якого платного виклику (LLM, ElevenLabs).
    const needsEpidemic =
      (phase !== "mix" && musicProvider === "epidemic") || (phase !== "music" && sfxProvider === "epidemic");
    if (needsEpidemic) {
      getEpidemicClient();
      getEpidemicDeps();
    }

    const sfxDeps: SfxDeps = {
      storage,
      client: getClient,
      gate,
      logger,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      now,
      qc: deps.qc ?? defaultSfxQc,
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

    /** Усі варіанти бібліотеки для `cues` (спільний кеш; промах — генерація); без тих, що не пройшли QC. */
    const ensureVariants = async (cues: readonly SoundCue[]): Promise<VariantFile[]> => {
      const results = await Promise.allSettled(
        cues.flatMap((cue) =>
          sfxLibrary[cue].map((def, i) => {
            const variant = i + 1;
            return ensureShared(variantLabel(cue, variant), def).then((file) => ({ cue, variant, file }));
          }),
        ),
      );
      const generated: VariantFile[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") generated.push(r.value);
        else logger.warn("варіант SFX не згенерувався — пропускаємо", { err: String(r.reason) });
      }
      // Семпли, що не пройшли QC, — поза ротацією, якщо в cue є інший варіант.
      const { kept, dropped: failedQc } = dropFailedQc(generated);
      if (failedQc.length > 0) {
        logger.warn("варіанти SFX не пройшли QC — поза ротацією", {
          variants: failedQc.map((v) => variantLabel(v.cue, v.variant)),
        });
      }
      return kept;
    };

    /**
     * SFX з Epidemic одним викликом провайдера: лише варіанти, які реально прозвучать (ротація
     * `variantIndices` за подіями ефективної розкадровки), плюс legacy `scene.sfxCue` (варіант 1) і
     * кастомні cue плану. Без `dropFailedQc`: провайдер уже лишив кращий із двох кандидатів.
     */
    const ensureEpidemicSfx = async (plan: AudioPlan): Promise<EpidemicSfxResult> => {
      const requests = new Map<string, SfxVariantRequest>();
      const add = (r: SfxVariantRequest) => {
        const key = variantLabel(r.cue, r.variant);
        if (!requests.has(key)) requests.set(key, r);
        return key;
      };
      const eventKeys = new Set<string>();
      for (const { cue, variant } of variantIndices(
        computeEventPlacements(storyboard),
        () => EPIDEMIC_SFX_POOL,
      )) {
        const pool = sfxLibrary[cue];
        const def = pool[(variant - 1) % pool.length];
        if (def) eventKeys.add(add({ cue, variant, def, custom: false }));
      }
      const legacyKeys = new Set<string>();
      const standard = loadStandardCues(ctx.prompts);
      const cues = referencedCues(draft);
      for (const cue of [...cues.standard, ...cues.custom]) {
        const spec = plan.sfx.find((s) => s.cue === cue);
        if (isStandardCue(cue)) {
          const def = standard[cue as keyof typeof standard];
          legacyKeys.add(add({ cue, variant: 1, def, custom: false }));
        } else if (spec?.custom) {
          const def = { text: spec.text, durationSeconds: spec.durationSeconds };
          legacyKeys.add(add({ cue, variant: 1, def, custom: true }));
        } else {
          logger.warn("SFX-cue без опису в аудіо-плані — пропускаємо", { cue });
        }
      }
      const result: EpidemicSfxResult = { variantFiles: [], legacyFiles: [], picked: [], downloads: 0 };
      if (requests.size === 0) return result;
      const ensureVariantsBy = deps.ensureSfxVariantsBy?.epidemic ?? ensureEpidemicSfxVariants;
      let got: Awaited<ReturnType<EnsureSfxVariantsFn>> = [];
      try {
        got = await ensureVariantsBy({ ...sfxDeps, epidemic: getEpidemicDeps(), cost: ctx.cost, projectId }, [
          ...requests.values(),
        ]);
      } catch (err) {
        if (err instanceof StageError) throw err;
        const mapped = epidemicStageError(err);
        if (mapped) throw mapped;
        if (ctx.signal?.aborted) throw err;
        logger.warn("SFX з Epidemic не отримано — події без звуку", { err: String(err) });
      }
      for (const r of got) {
        const key = variantLabel(r.cue, r.variant);
        const file: SfxFile = { ...r.file, cue: r.cue };
        if (eventKeys.has(key))
          result.variantFiles.push({ cue: r.cue as SoundCue, variant: r.variant, file });
        if (legacyKeys.has(key)) result.legacyFiles.push(file);
        result.picked.push({ cue: r.cue, variant: r.variant, id: r.epidemicId, title: r.title });
        if (r.file.generated) result.downloads++;
      }
      const gotKeys = new Set(got.map((r) => variantLabel(r.cue, r.variant)));
      const missing = [...requests.keys()].filter((k) => !gotKeys.has(k));
      if (missing.length > 0) logger.warn("Epidemic не дав семплів — події без звуку", { variants: missing });
      logger.info("SFX з Epidemic", {
        requested: requests.size,
        got: got.length,
        downloads: result.downloads,
      });
      return result;
    };

    /**
     * Зведення: трек + семпли бібліотеки SFX за таймлайном подій ефективної розкадровки + дакінг +
     * мастер → soundtrack.wav і звукова відомість. Кеш — за planHash + тональністю + таймлайном +
     * подіями + хешами варіантів семплів; без зведення (null) хост грає music і sfx, як раніше.
     */
    const produceMix = async (input: {
      planHash: string;
      /** Ключ треку в сховищі (той самий файл, що грає хост). */
      musicKey: string;
      eventKey: string | null;
      variantFiles: readonly VariantFile[];
      barOffsetMs: number | null;
    }): Promise<{ mix: MixManifestInput | null; artifacts: string[] }> => {
      const artifacts: string[] = [];
      try {
        const decodeOpts = ctx.signal ? { signal: ctx.signal } : {};
        const hashesOf = (files: ReadonlyArray<{ cue: SoundCue; file: SfxFile }>) => {
          const out: Partial<Record<SoundCue, string[]>> = {};
          for (const f of files) out[f.cue] = [...(out[f.cue] ?? []), f.file.hash];
          return out;
        };
        let mixHash = soundtrackHash({
          planHash: input.planHash,
          key: input.eventKey,
          storyboard,
          samples: hashesOf(input.variantFiles),
        });
        let mixKey = soundtrackCacheKey(projectId, input.planHash, mixHash);
        // Кеш — лише разом із фактами для відомості; старий кеш без них зводиться заново (той самий WAV).
        let master = (await storage.exists(mixKey))
          ? await readOptional(storage, mixMasterMetaKey(mixKey), (v) => MixMasterMeta.parse(v))
          : null;
        if (!master?.facts) {
          const pcm = await decode(await storage.read(input.musicKey), decodeOpts);
          // Семпли: помилка декодування варіанта — пропуск варіанта; cue без варіантів — події без звуку.
          const decoded = await Promise.allSettled(
            input.variantFiles.map(async (v) => ({
              ...v,
              pcm: await decode(await storage.read(v.file.key), decodeOpts),
            })),
          );
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("aborted");
          const samples: Partial<Record<SoundCue, SfxSample[]>> = {};
          const used: VariantFile[] = [];
          decoded.forEach((r, i) => {
            const v = input.variantFiles[i];
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
          // Семпли cue були, але жоден не декодувався — у відомості `decode_failed`, а не `no_sample`.
          const decodeFailed = new Set<SoundCue>();
          for (const cue of eventCuesOf(storyboard)) {
            if (samples[cue]?.length) continue;
            logger.warn("немає жодного семпла cue — події без звуку", { cue });
            if (input.variantFiles.some((v) => v.cue === cue)) decodeFailed.add(cue);
          }
          // Хеш — за фактично використаними семплами: наступний прогін повторить пропущені.
          mixHash = soundtrackHash({
            planHash: input.planHash,
            key: input.eventKey,
            storyboard,
            samples: hashesOf(used),
          });
          mixKey = soundtrackCacheKey(projectId, input.planHash, mixHash);
          const soundtrack = renderSoundtrack({ music: pcm, storyboard, key: input.eventKey, samples });
          master = {
            integratedLufs: round1(soundtrack.master.integratedLufs),
            truePeakDbtp: round1(soundtrack.master.truePeakDbtp),
            masterGainDb: round1(soundtrack.master.gainDb),
            facts: mixFacts(soundtrack, decodeFailed),
          };
          logger.info("зведення готове", {
            mixHash,
            events: soundtrack.sounds.length,
            silentEvents: soundtrack.silent.length,
            samples: used.length,
            beatShiftMs: master.facts?.beatShiftMs ?? null,
            beatConfidence: master.facts?.beatConfidence ?? null,
            musicGainDb: Math.round(gainToDb(soundtrack.masterGain) * 10) / 10,
            integratedLufs: master.integratedLufs,
            truePeakDbtp: master.truePeakDbtp,
            masterGainDb: master.masterGainDb,
          });
          await storage.write(mixKey, soundtrack.wav);
          await storage.writeJson(mixMasterMetaKey(mixKey), master);
        }
        const mixPublic = revPaths.publicFile(PUBLIC_MIX_FILE);
        await storage.copy(mixKey, mixPublic);
        artifacts.push(mixPublic);
        if (master.facts) {
          const sheet = buildSoundSheet(master.facts, {
            storyboard,
            draft,
            barOffsetMs: input.barOffsetMs,
            integratedLufs: master.integratedLufs,
            truePeakDbtp: master.truePeakDbtp,
          });
          await storage.writeJson(revPaths.soundSheet, sheet);
          artifacts.push(revPaths.soundSheet);
        }
        return {
          mix: {
            durationMs: layout.videoMs,
            integratedLufs: master.integratedLufs,
            truePeakDbtp: master.truePeakDbtp,
            masterGainDb: master.masterGainDb,
          },
          artifacts,
        };
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        logger.error("зведення не вдалося — хост гратиме музику і SFX окремо", { err: String(err) });
        return { mix: null, artifacts };
      }
    };

    // Фаза mix: трек і план — з фази music цієї ревізії; новий план SFX → новий хеш зведення.
    if (phase === "mix") {
      const plan = await readOptional(storage, revPaths.audioPlan, (v) => AudioPlan.parse(v));
      const manifest = await readOptional(storage, revPaths.audio, (v) => AudioManifest.parse(v));
      const musicKey = manifest?.music ? revPaths.publicFile(manifest.music.src) : null;
      if (!plan || !manifest?.music || !musicKey || !(await storage.exists(musicKey))) {
        throw new StageError(
          `audio: фаза mix без фази music (немає ${!plan ? revPaths.audioPlan : !manifest?.music ? revPaths.audio : musicKey})`,
          "audio_inputs_missing",
          "Немає треку для зведення.",
          false,
        );
      }
      const planHash = manifest.music.planHash;
      const meta = await readOptional(storage, paths.musicMeta(planHash), (v) => MusicMeta.parse(v));
      const epidemicSfx = sfxProvider === "epidemic" ? await ensureEpidemicSfx(plan) : null;
      const variantFiles = epidemicSfx
        ? epidemicSfx.variantFiles
        : await ensureVariants(eventCuesOf(storyboard));
      // Epidemic: фаза music SFX не чіпала — legacy-файли ревізії з'являються тут.
      const legacyArtifacts: string[] = [];
      for (const f of epidemicSfx?.legacyFiles ?? []) {
        const dest = revPaths.publicFile(publicSfxFile(f.cue, f.key));
        await storage.copy(f.key, dest);
        legacyArtifacts.push(dest);
      }
      const produced = await produceMix({
        planHash,
        musicKey,
        eventKey: resolveEventKey(meta?.check ?? null, plan.key, logger),
        variantFiles,
        barOffsetMs: meta?.check?.barOffsetMs ?? null,
      });
      const built = buildAudioManifest({
        storyboard: draft,
        music: null,
        sfx: (epidemicSfx?.legacyFiles ?? []).map((f) => ({
          cue: f.cue,
          durationMs: f.durationMs,
          key: f.key,
        })),
        mix: produced.mix,
      });
      const mixed = AudioManifest.parse({
        ...manifest,
        mix: built.mix,
        // Epidemic SFX: legacy-файли, провайдер і завантаження (накопичуються з фазою music і повторами mix).
        ...(epidemicSfx
          ? {
              sfx: built.sfx,
              providers: { music: manifest.providers.music, sfx: sfxProvider },
              epidemic: {
                trackId: manifest.epidemic?.trackId ?? null,
                sfx: epidemicSfx.picked,
                downloads: (manifest.epidemic?.downloads ?? 0) + epidemicSfx.downloads,
              },
            }
          : {}),
      });
      await storage.writeJson(revPaths.audio, mixed);
      const prev = await findPreviousMusic(storage, projectId, rev, project);
      return {
        artifacts: [...legacyArtifacts, ...produced.artifacts, revPaths.audio],
        outputs: { planHash, reusedMusic: prev?.meta.planHash === planHash, mixed: true },
      };
    }

    const brand = await readBrandKit(storage, projectId, project?.brandkitVersion ?? null);
    if (!brand) {
      throw new StageError(
        "audio: немає бренд-кіта",
        "audio_inputs_missing",
        "Немає бренд-кіта для музики.",
        false,
      );
    }
    const sanitizer = createSanitizer(brandTerms(brand));
    const standardCues = loadStandardCues(ctx.prompts);
    const briefHash = musicBriefHash(draft.musicBrief);

    // Повторне використання треку попередньої ревізії.
    const prev = await findPreviousMusic(storage, projectId, rev, project);
    const reuse = prev !== null && canReuseMusic(prev.meta, briefHash, layout.videoMs, musicProvider);

    // План: збережений у цій ревізії (повтор стадії) → план основи (якщо трек лишається) → LLM.
    let plan = await readOptional(storage, revPaths.audioPlan, (v) => AudioPlan.parse(v));
    if (plan && !planMatchesLayout(plan, layout, draft)) plan = null;
    if (!plan && reuse && prev.rev !== null) {
      const basePlan = await readOptional(storage, paths.rev(prev.rev).audioPlan, (v) => AudioPlan.parse(v));
      if (basePlan && planCoversCues(basePlan, draft)) plan = basePlan;
    }
    if (!plan) {
      const res = await ctx.llm.structured(
        AUDIO_PLAN_PROMPT,
        audioPlanVars(brand, draft, layout, sanitizer),
        AudioPlanDraft,
        ctx.signal ? { signal: ctx.signal } : {},
      );
      plan = normalizeAudioPlan(res.data, { layout, storyboard: draft, sanitizer, standardCues });
    }
    await storage.writeJson(revPaths.audioPlan, plan);
    const artifacts: string[] = [revPaths.audioPlan];

    const musicDeps = {
      storage,
      client: getClient,
      // Той самий декодер, що й у зведенні: перевірка треку бачить те саме, що чує мікс.
      decode,
      gate,
      cost: ctx.cost,
      logger,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      now,
    };

    const musicPromise = (async () => {
      if (reuse) {
        logger.info("трек попередньої ревізії лишається", { planHash: prev.meta.planHash });
        return { planHash: prev.meta.planHash, key: prev.key, meta: prev.meta, reused: true, downloads: 0 };
      }
      try {
        const override = deps.ensureMusicBy?.[musicProvider];
        const m =
          musicProvider === "epidemic" || override
            ? await (override ?? ensureEpidemicMusic)(
                { ...musicDeps, epidemic: getEpidemicDeps(), llm: ctx.llm, targetBpm: draft.musicBrief.bpm },
                projectId,
                plan,
                briefHash,
              )
            : await ensureMusic(musicDeps, projectId, plan, briefHash);
        return { ...m, reused: m.cached && m.planHash === prev?.meta.planHash };
      } catch (err) {
        if (err instanceof StageError) throw err;
        const mapped = musicProvider === "epidemic" ? epidemicStageError(err) : null;
        if (mapped) throw mapped;
        throw new StageError(
          `audio: музика не згенерувалась: ${(err as Error).message}`,
          "music_failed",
          "Не вдалося створити музику. Спробуйте ще раз.",
          true,
          { cause: err },
        );
      }
    })();

    /** SFX ElevenLabs — як до тесту Epidemic: legacy-файли і прогрів варіантів спільного кешу. */
    const elevenLabsSfx = async (): Promise<StageSfx> => {
      // Legacy `scene.sfxCue`: файли в public, хост грає їх, коли зведення немає.
      const cues = referencedCues(draft);
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
      // У фазі music — уся бібліотека: звукорежисер може вибрати будь-який cue, а mix не чекає генерації.
      const warmCues = phase === "music" ? SoundCue.options : eventCuesOf(storyboard);
      const [sfxResults, variantFiles] = await Promise.all([
        Promise.allSettled(sfxJobs),
        ensureVariants(warmCues),
      ]);
      const sfxFiles: SfxFile[] = [];
      for (const r of sfxResults) {
        if (r.status === "fulfilled") sfxFiles.push(r.value);
        else logger.warn("SFX не згенерувався — сцена буде без нього", { err: String(r.reason) });
      }
      return { sfxFiles, variantFiles, epidemic: null };
    };

    // Epidemic SFX: у фазі music — нічого (ні прогріву бібліотеки, ні legacy: їх робить mix за
    // відомими подіями); у mix/full — лише варіанти, що прозвучать. ElevenLabs — як сьогодні.
    const sfxPromise: Promise<StageSfx> =
      sfxProvider === "epidemic"
        ? phase === "music"
          ? Promise.resolve({ sfxFiles: [], variantFiles: [], epidemic: null })
          : ensureEpidemicSfx(plan).then((r) => ({
              sfxFiles: r.legacyFiles,
              variantFiles: r.variantFiles,
              epidemic: r,
            }))
        : elevenLabsSfx();
    const [music, sfx] = await Promise.all([musicPromise, sfxPromise]);
    const { sfxFiles, variantFiles } = sfx;

    // Файли для staticFile() хоста.
    const musicSrc = publicMusicFile(music.key);
    const musicPublic = revPaths.publicFile(musicSrc);
    await storage.copy(music.key, musicPublic);
    artifacts.push(musicPublic);
    for (const f of sfxFiles) {
      const dest = revPaths.publicFile(publicSfxFile(f.cue, f.key));
      await storage.copy(f.key, dest);
      artifacts.push(dest);
    }

    // Зведення (крім фази music). Тональність звуків подій: план або визначена за треком (`resolveEventKey`).
    let mix: MixManifestInput | null = null;
    if (phase !== "music") {
      const produced = await produceMix({
        planHash: music.planHash,
        musicKey: music.key,
        eventKey: resolveEventKey(music.meta.check, plan.key, logger),
        variantFiles,
        barOffsetMs: music.meta.check?.barOffsetMs ?? null,
      });
      mix = produced.mix;
      artifacts.push(...produced.artifacts);
    }

    const manifest = AudioManifest.parse(
      buildAudioManifest({
        storyboard: draft,
        music: { planHash: music.planHash, durationMs: music.meta.durationMs, src: musicSrc },
        sfx: sfxFiles.map((f) => ({ cue: f.cue, durationMs: f.durationMs, key: f.key })),
        mix,
        providers: { music: musicProvider, sfx: sfxProvider },
        epidemic: {
          trackId: music.meta.provider === "epidemic" ? (music.meta.epidemic?.trackId ?? null) : null,
          sfx: sfx.epidemic?.picked ?? [],
          downloads: (sfx.epidemic?.downloads ?? 0) + (music.downloads ?? 0),
        },
      }),
    );
    await storage.writeJson(revPaths.audio, manifest);
    artifacts.push(revPaths.audio);

    return {
      artifacts,
      outputs: { planHash: music.planHash, reusedMusic: music.reused, mixed: phase !== "music" },
    };
  };
}

/** Стадія `audio` з дефолтними залежностями (справжній ElevenLabs із env, спільна черга). */
export const audioStage: Stage<"audio"> = createAudioStage();
