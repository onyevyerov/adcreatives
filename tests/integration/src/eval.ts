import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  audibilityWindow,
  correlation,
  type DecodeAudio,
  decodeAudio,
  decodeWav,
  estimateBeatPhase,
  LOW_CORRELATION_HZ,
  loadSfxLibrary,
  lowBandOnsets,
  PUBLIC_MIX_FILE,
  PUBLIC_MUSIC_FILE,
  peakOf,
  renderSoundtrack,
  rmsOf,
  type SfxSample,
  type StereoPcm,
  sfxCacheKey,
  sfxHash,
} from "@adc/audio";
import { type JobRecord, PipeState } from "@adc/pipeline";
import {
  type AnthropicLike,
  AudioManifest,
  type CostEvent,
  computeEventPlacements,
  computeTimeline,
  createAnthropicClient,
  createPromptLoader,
  distribution,
  FilmReview,
  FORMATS,
  type Format,
  findRepoRoot,
  GRID_SOUND_CUES,
  groupUsd,
  HIT_SOUND_CUES,
  type Logger,
  loadRootEnv,
  MusicMeta,
  type MusicTrackCheck,
  makeJobId,
  noopLogger,
  type ProjectState,
  ProjectState as ProjectStateSchema,
  type PromptLoader,
  projectPaths,
  projectStatsRow,
  QaReport,
  readCosts,
  readTrace,
  readTuning,
  routeOf,
  type SoundCue,
  SoundSheet,
  type StageJob,
  type StageName,
  type Storage,
  Storyboard,
  sumUsd,
  type TraceEntry,
  TUNING_ENV,
  Tuning,
} from "@adc/shared";
import type { StageRegistry } from "@adc/worker";
import { z } from "zod";
import { autoApprove, createHarness, FORMAT_LABEL, type Harness, newProjectId } from "./harness.ts";

/**
 * `pnpm eval` — пайплайн без чату на сайтах із `eval/sites.json`: чекпоінти затверджуються
 * автоматично, витрати пишуться з `source: "eval"`. Результат — `eval/runs/<run>/`:
 * дані проєктів (`data/`), відео, стіли й аркуші кожного сайту (`sites/`), звіт `report.{json,md}`.
 *
 * `pnpm eval --from <stage> --run <run>` перезапускає один етап (і все, що після нього) зі збережених
 * даних попереднього прогону: дані копіюються в новий прогін, старий лишається недоторканим.
 * `--only` — виконати лише цей етап і зупинитись.
 *
 * Кожен сайт списку — це кейс (`name`): після прогону пишеться звіт кейсу `eval/out/<кейс>/report.{json,md}`
 * ($, токени й хвилини з `costs.jsonl`/`trace.jsonl`, рівні музики й подій, перевірка треку, мастер
 * LUFS/dBTP і тональність плану й треку, удари в розкадровці, критерії паритету й цілі звуку).
 * `--case <кейс>` проганяє один кейс, `--mode pipeline|agent` ставить
 * `ADC_GENERATION_MODE` воркеру eval на час прогону, `--audio <файл>` міряє будь-яку доріжку тими ж
 * метриками (порівняння з еталоном — `docs/analysis/README.md`).
 *
 * Режим звуку — з env, як решта `ADC_*` (воркер eval працює в цьому ж процесі): `ADC_SFX_MODE`
 * (`designer` — звукорежисер, `storyboard` — звук розкадровки) і `ADC_FILM_REVIEW` (`on`/`off`). Звіти
 * пишуть режим і з `sound-sheet.json`/`review.json` — оцінку рецензента, промахи повз долю і вимкнені події.
 */

// ───────────────────────────── сайти ─────────────────────────────

const FORMAT_ALIASES: Record<string, Format> = {
  vertical: "vertical",
  "9:16": "vertical",
  square: "square",
  "1:1": "square",
  landscape: "landscape",
  "16:9": "landscape",
};

const FormatInput = z.string().transform((v, ctx) => {
  const f = FORMAT_ALIASES[v.trim().toLowerCase()];
  if (!f) {
    ctx.addIssue({ code: "custom", message: `невідомий формат "${v}" (9:16, 1:1, 16:9)` });
    return z.NEVER;
  }
  return f;
});

/** Рядок у списку — це просто URL. */
export const SiteSpec = z.preprocess(
  (v) => (typeof v === "string" ? { url: v } : v),
  z.object({
    url: z.string().min(1).optional(),
    /** Опис бізнесу вручну (без сайту або на додачу до нього). */
    text: z.string().min(1).optional(),
    /** Коротка назва для звіту і теки результатів. */
    name: z.string().min(1).optional(),
    formats: z.array(FormatInput).min(1).optional(),
    language: z.enum(["uk", "en"]).optional(),
    /** Фото клієнта: шляхи відносно sites.json. */
    photos: z.array(z.string()).optional(),
    /** Тривалість ролика, с (15–30); не задано — вирішує сценарист. */
    durationSeconds: z.number().int().min(15).max(30).optional(),
  }),
);
export type SiteSpecInput = z.input<typeof SiteSpec>;

export interface EvalSite {
  name: string;
  url: string | null;
  text: string | null;
  formats: Format[];
  language: "uk" | "en" | null;
  photos: string[];
  durationSeconds: number | null;
}

export function slugify(value: string): string {
  return (
    value
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .toLowerCase()
      .replace(/[^a-z0-9а-яіїєґ]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "site"
  );
}

/** Читає й перевіряє список сайтів. Відсутній файл — порожній список. */
export async function loadSites(file: string): Promise<EvalSite[]> {
  if (!existsSync(file)) return [];
  const raw = (await readFile(file, "utf8")).trim();
  if (!raw) return [];
  const parsed = z.array(SiteSpec).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${file}: ${parsed.error.issues.map((i) => `[${i.path.join(".")}] ${i.message}`).join("; ")}`,
    );
  }
  const base = path.dirname(file);
  return parsed.data.map((spec, i) => {
    if (!spec.url && !spec.text) throw new Error(`${file}: сайт #${i + 1} без url і text`);
    const name = spec.name ?? (spec.url ? slugify(spec.url) : `manual-${i + 1}`);
    return {
      name,
      url: spec.url ?? null,
      text: spec.text ?? null,
      formats: spec.formats ? FORMATS.filter((f) => spec.formats?.includes(f)) : ["vertical"],
      language: spec.language ?? null,
      photos: (spec.photos ?? []).map((p) => path.resolve(base, p)),
      durationSeconds: spec.durationSeconds ?? null,
    };
  });
}

// ───────────────────────────── аргументи ─────────────────────────────

/** Етапи, з яких можна перезапустити прогін (`crawl` — це просто новий прогін). */
export const RERUN_STAGES = [
  "brandkit",
  "storyboard",
  "codegen",
  "check",
  "qa",
  "sfx",
  "audio",
  "review",
  "render",
] as const;
export type RerunStage = (typeof RERUN_STAGES)[number];

/** Режими генерації (`Tuning.generationMode`, env `ADC_GENERATION_MODE`). */
export const GENERATION_MODES = ["pipeline", "agent"] as const satisfies ReadonlyArray<
  Tuning["generationMode"]
>;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export interface EvalArgs {
  sites: string;
  runsDir: string;
  from: RerunStage | null;
  run: string | null;
  only: boolean;
  parallel: number;
  timeoutMinutes: number;
  /** Лише сайт списку з цим `name`. */
  caseName: string | null;
  /** `ADC_GENERATION_MODE` воркера eval на час прогону; null — як у env. */
  mode: GenerationMode | null;
  /** Куди писати звіти кейсів (дефолт — `out/` поруч із текою прогонів: `eval/out`). */
  caseOut: string;
  /** `--audio <файл>`: лише виміряти доріжку й вийти. */
  audio: string | null;
  /** Темп для `--audio` (впевненість долі); null — без неї. */
  bpm: number | null;
  help: boolean;
}

export const EVAL_USAGE = `Використання:
  pnpm eval                                 прогін по eval/sites.json → eval/runs/<дата>/
  pnpm eval --case <кейс> --mode <режим>    один кейс зі списку; звіт кейсу → eval/out/<кейс>/report.json
  pnpm eval --from <етап> --run <прогін>    перезапуск етапу зі збережених даних прогону
  pnpm eval --audio <файл> [--bpm <n>]      аудіо-метрики доріжки (WAV або що читає ffmpeg), без API
Опції:
  --sites <файл>       список сайтів (дефолт eval/sites.json)
  --out <тека>         де лежать прогони (дефолт eval/runs)
  --case <кейс>        лише сайт списку з цим name
  --mode <режим>       ${GENERATION_MODES.join(" | ")} → ADC_GENERATION_MODE воркера eval на час прогону
  --case-out <тека>    куди писати звіти кейсів (дефолт eval/out)
  --from <етап>        ${RERUN_STAGES.join(" | ")}
  --run <прогін>       тека в eval/runs/, з якої брати дані (для --from)
  --only               лише цей етап, без подальших
  --parallel <n>       скільки сайтів одночасно (дефолт 1)
  --timeout <хв>       ліміт на сайт (дефолт 60)
Режим звуку — з env: ADC_SFX_MODE=designer|storyboard, ADC_FILM_REVIEW=on|off, ADC_REVIEW_MAX_ROUNDS=0..2`;

export function parseEvalArgs(argv: readonly string[], root: string = findRepoRoot()): EvalArgs {
  const args: EvalArgs = {
    sites: path.join(root, "eval", "sites.json"),
    runsDir: path.join(root, "eval", "runs"),
    from: null,
    run: null,
    only: false,
    parallel: 1,
    timeoutMinutes: 60,
    caseName: null,
    mode: null,
    caseOut: "",
    audio: null,
    bpm: null,
    help: false,
  };
  let caseOut: string | null = null;
  const rest = [...argv];
  const value = (flag: string): string => {
    const v = rest.shift();
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag}: потрібне значення`);
    return v;
  };
  while (rest.length > 0) {
    const raw = rest.shift() as string;
    const [flag, inline] = raw.includes("=") ? (raw.split(/=(.*)/s, 2) as [string, string]) : [raw, null];
    const get = () => inline ?? value(flag);
    switch (flag) {
      case "--sites":
        args.sites = path.resolve(get());
        break;
      case "--out":
        args.runsDir = path.resolve(get());
        break;
      case "--from": {
        const stage = get();
        if (!(RERUN_STAGES as readonly string[]).includes(stage)) {
          throw new Error(`--from: невідомий етап "${stage}" (${RERUN_STAGES.join(", ")})`);
        }
        args.from = stage as RerunStage;
        break;
      }
      case "--run":
        args.run = get();
        break;
      case "--only":
        args.only = true;
        break;
      case "--parallel":
        args.parallel = Math.max(1, Math.floor(Number(get())) || 1);
        break;
      case "--timeout":
        args.timeoutMinutes = Math.max(1, Number(get()) || 60);
        break;
      case "--case":
        args.caseName = get();
        break;
      case "--mode": {
        const mode = get();
        if (!(GENERATION_MODES as readonly string[]).includes(mode)) {
          throw new Error(`--mode: невідомий режим "${mode}" (${GENERATION_MODES.join(", ")})`);
        }
        args.mode = mode as GenerationMode;
        break;
      }
      case "--case-out":
        caseOut = path.resolve(get());
        break;
      case "--audio":
        args.audio = path.resolve(get());
        break;
      case "--bpm": {
        const bpm = Number(get());
        if (!(bpm >= 40 && bpm <= 240)) throw new Error("--bpm: очікується число 40–240");
        args.bpm = bpm;
        break;
      }
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--":
        break;
      default:
        throw new Error(`невідомий аргумент "${raw}"`);
    }
  }
  if (args.from && !args.run) throw new Error("--from потребує --run <прогін>");
  if (args.run && !args.from) throw new Error("--run використовується разом із --from <етап>");
  if (args.only && !args.from) throw new Error("--only використовується разом із --from <етап>");
  if (args.caseName && args.from) throw new Error("--case — лише для нового прогону (без --from)");
  if (args.bpm !== null && !args.audio) throw new Error("--bpm використовується разом із --audio <файл>");
  args.caseOut = caseOut ?? path.join(path.dirname(args.runsDir), "out");
  return args;
}

/** Ім'я прогону: `2026-10-06-1530` (+ `-2`, `-3`… якщо тека вже є). */
export function runName(now: Date, runsDir: string, suffix = ""): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${suffix}`;
  let name = base;
  for (let i = 2; existsSync(path.join(runsDir, name)); i++) name = `${base}-${i}`;
  return name;
}

/**
 * Ставить `ADC_GENERATION_MODE` на час прогону: воркер eval працює в цьому ж процесі, а оркестратор і
 * стадії читають `readTuning()` з env на кожен крок. Повертає відкат до попереднього значення.
 */
export function applyGenerationMode(
  mode: GenerationMode | null,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  if (mode === null) return () => {};
  const name = TUNING_ENV.generationMode;
  const had = Object.hasOwn(env, name);
  const prev = env[name];
  env[name] = mode;
  return () => {
    if (had) env[name] = prev;
    else delete env[name];
  };
}

/** Режим звуку воркера eval: звукорежисер і рецензент (`ADC_SFX_MODE`, `ADC_FILM_REVIEW`, `ADC_REVIEW_MAX_ROUNDS`). */
export type SoundTuning = Pick<Tuning, "sfxMode" | "filmReview" | "reviewMaxRounds">;

/** Режим звуку, з яким реально працюватиме воркер (невалідний env — дефолти). */
export function currentSoundTuning(env: NodeJS.ProcessEnv = process.env): SoundTuning {
  let t: Tuning;
  try {
    t = readTuning(env);
  } catch {
    t = Tuning.parse({});
  }
  return { sfxMode: t.sfxMode, filmReview: t.filmReview, reviewMaxRounds: t.reviewMaxRounds };
}

/** Режим генерації, з яким реально працюватиме воркер (невалідний env — дефолт `pipeline`). */
export function currentGenerationMode(env: NodeJS.ProcessEnv = process.env): GenerationMode {
  try {
    return readTuning(env).generationMode;
  } catch {
    return "pipeline";
  }
}

// ───────────────────────────── перезапуск етапу ─────────────────────────────

/**
 * Готує проєкт збереженого прогону до перезапуску етапу: стан і `pipeline.json` поточної ревізії
 * виставляються так, ніби оркестратор щойно поставив цей job (далі все йде звичайним шляхом).
 * Повертає job, які треба поставити в чергу.
 *
 * Звук іде за `sfxMode` воркера (як `startDirecting` машини): у режимі `designer` трек і план попереднього
 * прогону вважаються готовими, після відео — `sfx` → `audio{mix}` → `review`; `--from audio` ставить
 * `audio{music}` (план SFX попереднього прогону лишається), у режимі `storyboard` — `audio{full}`.
 */
export async function prepareRerun(
  storage: Storage,
  projectId: string,
  stage: RerunStage,
  now: Date = new Date(),
  sfxMode: Tuning["sfxMode"] = currentSoundTuning().sfxMode,
): Promise<StageJob[]> {
  const paths = projectPaths(projectId);
  const project: ProjectState = await storage.readJson(paths.project, (v) => ProjectStateSchema.parse(v));
  const rev = project.rev;
  const pipeKey = paths.rev(rev).pipeline;
  const old = (await storage.exists(pipeKey))
    ? await storage.readJson(pipeKey, (v) => PipeState.parse(v))
    : PipeState.parse({ attempts: {}, fixRounds: {}, qaRounds: 0, templateScenes: [], dirtyScenes: [] });

  if (stage !== "brandkit" && project.brandkitVersion === null) {
    throw new Error(`${projectId}: немає бренд-кіта — перезапуск з «${stage}» неможливий`);
  }
  if (stage === "sfx" && sfxMode !== "designer") {
    throw new Error(`${projectId}: перезапуск з «sfx» — лише в режимі звукорежисера (ADC_SFX_MODE=designer)`);
  }
  if (["codegen", "check", "qa", "sfx", "audio", "review", "render"].includes(stage)) {
    if (!(await storage.exists(paths.rev(rev).storyboard))) {
      throw new Error(`${projectId}: немає розкадровки ревізії ${rev} — перезапуск з «${stage}» неможливий`);
    }
  }
  if (
    ["check", "qa", "sfx", "review", "render"].includes(stage) &&
    !(await storage.exists(paths.rev(rev).scenesIndex))
  ) {
    throw new Error(`${projectId}: немає коду сцен ревізії ${rev} — перезапуск з «${stage}» неможливий`);
  }
  if ((stage === "render" || stage === "review") && !(await storage.exists(paths.rev(rev).audio))) {
    throw new Error(`${projectId}: немає audio.json ревізії ${rev} — перезапуск з «${stage}» неможливий`);
  }

  const pipe = PipeState.parse({
    ...old,
    outstanding: [],
    failedJobs: [],
    ioQueue: [],
    afterPatch: null,
    pendingRevise: null,
  });
  const jobs: StageJob[] = [];
  const enqueue = <S extends StageName>(s: S, params: StageJob<S>["params"], suffix?: string) => {
    const key = suffix ? `${s}:${suffix}` : s;
    const attempt = (pipe.attempts[key] ?? 0) + 1;
    pipe.attempts[key] = attempt;
    const job = {
      jobId: makeJobId(projectId, s, rev, attempt, suffix),
      projectId,
      rev,
      stage: s,
      attempt,
      params,
    } as StageJob;
    jobs.push(job);
    pipe.outstanding.push(job as unknown as JobRecord);
  };
  const resetVideo = () => {
    pipe.videoPhase = "build";
    pipe.fixRounds = {};
    pipe.qaRounds = 0;
    pipe.templateScenes = [];
    pipe.dirtyScenes = [];
    pipe.changedScenes = null;
  };
  /** Звук ревізії: режим і що з music/sfx уже готове (як фіксує `startDirecting`); коло рецензії з нуля. */
  const resetSound = (ready: { music: boolean; sfx: boolean }) => {
    pipe.sfxMode = sfxMode;
    pipe.musicDone = ready.music;
    pipe.sfxDone = ready.sfx;
    pipe.reviewRounds = 0;
    pipe.pendingSfx = null;
  };
  const designer = sfxMode === "designer";
  /** Відео заново: у режимі designer аудіогілка чекає зведення після sfx (трек попереднього прогону готовий). */
  const videoBranches = (): ProjectState["branches"] => ({
    video: "running",
    audio: designer ? "running" : "done",
  });

  const next: ProjectState = {
    ...project,
    failure: null,
    pendingMessages: [],
    restartRequested: false,
    // Перезапуск рахується як перша видача: так витрати й машинний час потрапляють у звіт eval.
    phase: "first_delivery",
    firstDeliveredAt: null,
    deliveredAt: null,
    updatedAt: now.toISOString(),
  };
  switch (stage) {
    case "brandkit":
      next.status = "brandkit";
      next.branches = { video: "idle", audio: "idle" };
      resetVideo();
      enqueue("brandkit", {});
      break;
    case "storyboard":
      next.status = "scripting";
      next.branches = { video: "idle", audio: "idle" };
      resetVideo();
      enqueue("storyboard", { durationSeconds: project.durationSeconds });
      break;
    case "codegen":
      next.status = "directing";
      next.branches = videoBranches();
      resetVideo();
      resetSound({ music: true, sfx: false });
      enqueue("codegen", { sceneIds: null, instructions: [] });
      break;
    case "check":
      next.status = "directing";
      next.branches = videoBranches();
      resetVideo();
      resetSound({ music: true, sfx: false });
      enqueue("check", { sceneIds: null });
      break;
    case "qa":
      next.status = "directing";
      next.branches = videoBranches();
      pipe.videoPhase = "build";
      pipe.qaRounds = 0;
      pipe.dirtyScenes = [];
      pipe.changedScenes = null;
      resetSound({ music: true, sfx: false });
      enqueue("qa", { sceneIds: null });
      break;
    case "sfx":
      // Картинка попереднього прогону готова: звукорежисер по всіх сценах → audio{mix} → review.
      next.status = "directing";
      next.branches = { video: "running", audio: "running" };
      pipe.videoPhase = "build";
      pipe.dirtyScenes = [];
      pipe.changedScenes = null;
      resetSound({ music: true, sfx: false });
      enqueue("sfx", { sceneIds: null, instructions: [] });
      break;
    case "audio":
      // designer: трек заново, далі зведення за планом SFX попереднього прогону (sfx вважається готовим).
      next.status = "directing";
      next.branches = { video: "done", audio: "running" };
      resetSound({ music: false, sfx: true });
      enqueue("audio", { phase: designer ? "music" : "full" });
      break;
    case "review":
      // Фільм і зведення попереднього прогону; коло рецензії з нуля (з --only — лише оцінка).
      next.status = "directing";
      next.branches = { video: "done", audio: "done" };
      pipe.videoPhase = "build";
      pipe.dirtyScenes = [];
      pipe.changedScenes = null;
      resetSound({ music: true, sfx: true });
      enqueue("review", { round: 0 });
      break;
    case "render":
      next.status = "rendering";
      next.branches = { video: "done", audio: "done" };
      for (const format of project.formats) enqueue("render", { format }, format);
      break;
  }
  await storage.writeJson(pipeKey, pipe);
  await storage.writeJson(paths.project, ProjectStateSchema.parse(next));
  return jobs;
}

// ───────────────────────────── звіт ─────────────────────────────

export interface SiteReport {
  name: string;
  site: string;
  projectId: string;
  status: string;
  delivered: boolean;
  error: string | null;
  formats: Format[];
  videoSeconds: number | null;
  scenes: number;
  /** Сцени, що скомпілювались і відрендерились без жодного кола фіксів. */
  firstTryScenes: number;
  templateScenes: number;
  /** QA з першого разу сказав pass (без кола фіксів після QA); null — QA не було. */
  qaFirstPass: boolean | null;
  qaWarnings: { critical: number; major: number; minor: number };
  /** Рецензія фільму (`review.json`); null — рецензії не було (режим без неї або старі дані). */
  review: CaseReview | null;
  /** Звукова відомість (`sound-sheet.json`); null — зведення без відомості (старі дані). */
  sound: CaseSound | null;
  usd: number;
  usdByStage: Array<{ key: string; usd: number }>;
  usdByProvider: Array<{ key: string; usd: number }>;
  llmCalls: number;
  /** Від старту до видачі (або зупинки), с. */
  wallSeconds: number;
  /** Сума тривалостей стадій цього прогону, с. */
  machineSeconds: number;
  /** Скопійовані результати відносно теки прогону. */
  files: string[];
}

export interface EvalReport {
  run: string;
  startedAt: string;
  finishedAt: string;
  /** Режим генерації воркера eval (`ADC_GENERATION_MODE`). */
  mode: GenerationMode;
  /** Режим звуку воркера eval (`ADC_SFX_MODE`, `ADC_FILM_REVIEW`, `ADC_REVIEW_MAX_ROUNDS`). */
  soundMode: SoundTuning;
  from: RerunStage | null;
  baseRun: string | null;
  only: boolean;
  sites: SiteReport[];
  summary: {
    sites: number;
    delivered: number;
    failed: number;
    totalUsd: number;
    usdPerDelivered: ReturnType<typeof distribution>;
    wallSecondsPerDelivered: ReturnType<typeof distribution>;
    machineSecondsPerDelivered: ReturnType<typeof distribution>;
    /** Частка сцен, що скомпілювались із першої спроби. */
    firstTryShare: number | null;
    /** Частка проєктів, де QA з першого разу сказав pass. */
    qaPassShare: number | null;
    /** Частка сцен, замінених на TemplateScene. */
    templateShare: number | null;
    /** Середня оцінка рецензента по сайтах із рецензією; null — рецензій не було. */
    reviewScoreMean: number | null;
    usdByStage: Array<{ key: string; usd: number }>;
  };
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

async function readOptional<T>(storage: Storage, key: string, parse: (v: unknown) => T): Promise<T | null> {
  try {
    if (!(await storage.exists(key))) return null;
    return await storage.readJson(key, parse);
  } catch {
    return null;
  }
}

/** Поріг промаху повз долю у відомості, мс (як `sfx_off_beat` у промпті рецензента). */
export const OFF_BEAT_MS = 20;

export interface CaseReview {
  score: number;
  verdict: FilmReview["verdict"];
  /** Коло останньої рецензії ревізії (0 — перша). */
  round: number;
  summary: string;
  issues: number;
  /** Зауваження за маршрутом (`routeOf`) і за серйозністю. */
  byRoute: { fix: number; sfx: number; music: number; none: number };
  bySeverity: { critical: number; major: number; minor: number };
}

export interface CaseSound {
  /** Подій у відомості (зі звуком у розкадровці або плані). */
  events: number;
  /** Вимкнені планом звукорежисера (`silent: "muted"`). */
  muted: number;
  /** Не прозвучали з технічних причин (`no_sample`, `decode_failed`). */
  silent: number;
  /** Події, що звучать, з |beatOffsetMs| ≥ `OFF_BEAT_MS`, крім grid-cue (`GRID_SOUND_CUES`). */
  offBeat: number;
  /** Важкі удари (`HIT_SOUND_CUES`), що звучать. */
  heavyHits: number;
  /** Старти сцен не на такті (`onBar === false`). */
  sceneStartsOffBar: number;
}

export function reviewStats(review: FilmReview): CaseReview {
  const byRoute = { fix: 0, sfx: 0, music: 0, none: 0 };
  const bySeverity = { critical: 0, major: 0, minor: 0 };
  for (const issue of review.issues) {
    byRoute[routeOf(issue.kind)] += 1;
    bySeverity[issue.severity] += 1;
  }
  return {
    score: review.score,
    verdict: review.verdict,
    round: review.round,
    summary: review.summary,
    issues: review.issues.length,
    byRoute,
    bySeverity,
  };
}

export function soundSheetStats(sheet: SoundSheet): CaseSound {
  const sounding = sheet.events.filter((e) => e.silent === "none");
  return {
    events: sheet.events.length,
    muted: sheet.events.filter((e) => e.silent === "muted").length,
    silent: sheet.events.filter((e) => e.silent === "no_sample" || e.silent === "decode_failed").length,
    offBeat: sounding.filter(
      (e) =>
        !GRID_SOUND_CUES.has(e.cue) && e.beatOffsetMs !== null && Math.abs(e.beatOffsetMs) >= OFF_BEAT_MS,
    ).length,
    heavyHits: sounding.filter((e) => HIT_SOUND_CUES.has(e.cue)).length,
    sceneStartsOffBar: sheet.sceneStarts.filter((s) => s.onBar === false).length,
  };
}

/** Рецензія і відомість звуку ревізії; немає файлу або він не за схемою (старі дані) — null. */
export async function readReviewAndSound(
  storage: Storage,
  projectId: string,
  rev: number,
): Promise<{ review: CaseReview | null; sound: CaseSound | null }> {
  const revPaths = projectPaths(projectId).rev(rev);
  const review = await readOptional(storage, revPaths.review, (v) => FilmReview.parse(v));
  const sheet = await readOptional(storage, revPaths.soundSheet, (v) => SoundSheet.parse(v));
  return { review: review ? reviewStats(review) : null, sound: sheet ? soundSheetStats(sheet) : null };
}

/** Метрики одного проєкту; враховуються лише витрати й стадії з моменту `since`. */
export async function buildSiteReport(
  storage: Storage,
  projectId: string,
  meta: { name: string; since: Date; wallSeconds: number; files?: string[]; error?: string | null },
): Promise<SiteReport> {
  const paths = projectPaths(projectId);
  const project = await readOptional(storage, paths.project, (v) => ProjectStateSchema.parse(v));
  const statsRow = project
    ? (await projectStatsRow(storage, projectId, { targetUsd: 0, chatUrl: () => "" }))?.row
    : null;
  const rev = project ? paths.rev(project.rev) : null;
  const storyboard = rev ? await readOptional(storage, rev.storyboard, (v) => Storyboard.parse(v)) : null;
  const pipe = rev ? await readOptional(storage, rev.pipeline, (v) => PipeState.parse(v)) : null;
  const qa = rev ? await readOptional(storage, rev.qa, (v) => QaReport.parse(v)) : null;
  const sinceIso = meta.since.toISOString();
  const costs = (await readCosts(storage, projectId)).filter((e) => e.ts >= sinceIso);
  const trace = (await readTrace(storage, projectId)).filter((t) => t.startedAt >= sinceIso);

  const sceneIds = storyboard?.scenes.map((s) => s.id) ?? [];
  const templates = new Set(pipe?.templateScenes ?? []);
  const firstTry = sceneIds.filter((s) => !templates.has(s) && (pipe?.fixRounds[s] ?? 0) === 0).length;
  const qaRan = trace.some((t) => t.stage === "qa" && t.ok);
  const warnings = { critical: 0, major: 0, minor: 0 };
  for (const issue of qa?.issues ?? []) warnings[issue.severity] += 1;
  const { review, sound } = project
    ? await readReviewAndSound(storage, projectId, project.rev)
    : { review: null, sound: null };

  const delivered = project?.status === "delivered";
  return {
    name: meta.name,
    site: project?.input.url ?? (project ? "(текст вручну)" : "?"),
    projectId,
    status: project?.status ?? "missing",
    delivered,
    error:
      meta.error ?? (project?.failure ? `${project.failure.stage}: ${project.failure.userMessage}` : null),
    formats: project?.formats ?? [],
    videoSeconds: statsRow?.videoSeconds ?? null,
    scenes: sceneIds.length,
    firstTryScenes: firstTry,
    templateScenes: templates.size,
    qaFirstPass: qaRan ? (pipe?.qaRounds ?? 0) === 0 : null,
    qaWarnings: warnings,
    review,
    sound,
    usd: round(sumUsd(costs)),
    usdByStage: groupUsd(costs, (e) => e.stage).map((g) => ({ key: g.key, usd: round(g.usd) })),
    usdByProvider: groupUsd(costs, (e) => e.provider).map((g) => ({ key: g.key, usd: round(g.usd) })),
    llmCalls: costs.filter((e) => e.provider === "anthropic").length,
    wallSeconds: Math.round(meta.wallSeconds),
    machineSeconds: Math.round(trace.reduce((a, t) => a + t.durationMs, 0) / 100) / 10,
    files: meta.files ?? [],
  };
}

export function summarize(sites: readonly SiteReport[]): EvalReport["summary"] {
  const delivered = sites.filter((s) => s.delivered);
  const scenes = sites.reduce((a, s) => a + s.scenes, 0);
  const qa = sites.filter((s) => s.qaFirstPass !== null);
  const scores = sites.flatMap((s) => (s.review ? [s.review.score] : []));
  const byStage = new Map<string, number>();
  for (const s of sites) for (const g of s.usdByStage) byStage.set(g.key, (byStage.get(g.key) ?? 0) + g.usd);
  return {
    sites: sites.length,
    delivered: delivered.length,
    failed: sites.length - delivered.length,
    totalUsd: round(sites.reduce((a, s) => a + s.usd, 0)),
    usdPerDelivered: distribution(delivered.map((s) => s.usd)),
    wallSecondsPerDelivered: distribution(delivered.map((s) => s.wallSeconds)),
    machineSecondsPerDelivered: distribution(delivered.map((s) => s.machineSeconds)),
    firstTryShare: scenes > 0 ? round(sites.reduce((a, s) => a + s.firstTryScenes, 0) / scenes, 3) : null,
    qaPassShare: qa.length > 0 ? round(qa.filter((s) => s.qaFirstPass).length / qa.length, 3) : null,
    templateShare: scenes > 0 ? round(sites.reduce((a, s) => a + s.templateScenes, 0) / scenes, 3) : null,
    reviewScoreMean: scores.length > 0 ? round(scores.reduce((a, v) => a + v, 0) / scores.length, 1) : null,
    usdByStage: [...byStage.entries()]
      .map(([key, usd]) => ({ key, usd: round(usd) }))
      .sort((a, b) => b.usd - a.usd),
  };
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);
const sec = (v: number | null) => (v === null ? "—" : `${Math.round(v)} с`);
/** «designer, рецензія on (кіл ≤ 1)». */
const soundModeStr = (m: SoundTuning) =>
  `${m.sfxMode}, рецензія ${m.filmReview ? `on (кіл ≤ ${m.reviewMaxRounds})` : "off"}`;
const dashOr = <T>(v: T | null | undefined, f: (v: T) => string | number) =>
  v === null || v === undefined ? "—" : String(f(v));

/** Рядок таблиці «Звук і рецензія» (по кейсу): score, offBeat, muted і решта лічильників. */
function soundReviewRow(name: string, review: CaseReview | null, sound: CaseSound | null): string {
  return [
    name,
    dashOr(review, (r) => r.score),
    dashOr(review, (r) => r.verdict),
    dashOr(sound, (x) => x.offBeat),
    dashOr(sound, (x) => x.muted),
    dashOr(sound, (x) => x.events),
    dashOr(sound, (x) => x.heavyHits),
    dashOr(sound, (x) => x.sceneStartsOffBar),
    dashOr(review, (r) => `${r.byRoute.fix}/${r.byRoute.sfx}/${r.byRoute.music}`),
    dashOr(review, (r) => `${r.bySeverity.critical}/${r.bySeverity.major}/${r.bySeverity.minor}`),
  ].join(" | ");
}

const SOUND_REVIEW_HEAD = [
  "| Кейс | score | Вердикт | offBeat | muted | Подій | Важкі удари | Старти поза тактом | Зауваження fix/sfx/music | critical/major/minor |",
  "|---|---|---|---|---|---|---|---|---|---|",
];
const SOUND_REVIEW_NOTE =
  `score — оцінка рецензента 1–10 (\`review.json\`); offBeat — події, що звучать, з |зсувом до долі| ≥ ${OFF_BEAT_MS} мс ` +
  "(крім grid-cue); muted — вимкнені звукорежисером (`sound-sheet.json`). «—» — файлу немає (режим без стадії або старі дані).";

export function reportMarkdown(report: EvalReport): string {
  const s = report.summary;
  const lines = [
    `# Eval ${report.run}`,
    "",
    `Старт ${report.startedAt}, кінець ${report.finishedAt}. Режим генерації: ${report.mode}. ` +
      `Звук: ${soundModeStr(report.soundMode)}.` +
      (report.from
        ? ` Перезапуск з етапу «${report.from}» прогону ${report.baseRun}${report.only ? " (лише цей етап)" : ""}.`
        : ""),
    "",
    "## Підсумок",
    "",
    "| Метрика | Значення |",
    "|---|---|",
    `| Сайтів / готових / не дійшли | ${s.sites} / ${s.delivered} / ${s.failed} |`,
    `| Усього витрачено | ${usd(s.totalUsd)} |`,
    `| Вартість готового відео: середня / медіана / p90 / макс | ${usd(s.usdPerDelivered.mean)} / ${usd(s.usdPerDelivered.median)} / ${usd(s.usdPerDelivered.p90)} / ${usd(s.usdPerDelivered.max)} |`,
    `| Час до видачі (настінний): середній / медіана / макс | ${sec(s.wallSecondsPerDelivered.mean)} / ${sec(s.wallSecondsPerDelivered.median)} / ${sec(s.wallSecondsPerDelivered.max)} |`,
    `| Машинний час до видачі: середній / макс | ${sec(s.machineSecondsPerDelivered.mean)} / ${sec(s.machineSecondsPerDelivered.max)} |`,
    `| Сцени, що скомпілювались з першої спроби | ${pct(s.firstTryShare)} |`,
    `| QA pass з першого разу | ${pct(s.qaPassShare)} |`,
    `| Сцени-шаблони (TemplateScene) | ${pct(s.templateShare)} |`,
    `| Оцінка рецензента, середня | ${s.reviewScoreMean ?? "—"} |`,
    "",
    "## Витрати за етапами",
    "",
    "| Етап | USD |",
    "|---|---|",
    ...s.usdByStage.map((g) => `| ${g.key} | ${usd(g.usd)} |`),
    "",
    "## Сайти",
    "",
    "| Сайт | Статус | Формати | Відео | Сцен | 1-а спроба | Шаблони | QA pass | Попередження QA | USD | Час | Машинний час |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...report.sites.map(
      (r) =>
        `| ${r.name} | ${r.status}${r.error ? ` — ${r.error.replaceAll("|", "/")}` : ""} | ${r.formats.map((f) => FORMAT_LABEL[f]).join(", ")} | ${sec(r.videoSeconds)} | ${r.scenes} | ${r.firstTryScenes} | ${r.templateScenes} | ${r.qaFirstPass === null ? "—" : r.qaFirstPass ? "так" : "ні"} | ${r.qaWarnings.critical}/${r.qaWarnings.major}/${r.qaWarnings.minor} | ${usd(r.usd)} | ${sec(r.wallSeconds)} | ${sec(r.machineSeconds)} |`,
    ),
    "",
    "Попередження QA: critical/major/minor (що лишилось після кола фіксів). Відео, стіли й аркуші — у `sites/<сайт>/`.",
    "",
    "## Звук і рецензія",
    "",
    ...SOUND_REVIEW_HEAD,
    ...report.sites.map((r) => `| ${soundReviewRow(r.name, r.review ?? null, r.sound ?? null)} |`),
    "",
    SOUND_REVIEW_NOTE,
    "",
  ];
  return lines.join("\n");
}

/** Копіює результати поточної ревізії проєкту в `sites/<name>/` прогону. */
export async function collectArtifacts(
  storage: Storage,
  projectId: string,
  runDir: string,
  name: string,
): Promise<string[]> {
  const project = await readOptional(storage, projectPaths(projectId).project, (v) =>
    ProjectStateSchema.parse(v),
  );
  if (!project) return [];
  const rev = projectPaths(projectId).rev(project.rev);
  const outDir = path.join(runDir, "sites", name);
  const copied: string[] = [];
  const copy = async (key: string, rel: string) => {
    if (!(await storage.exists(key))) return;
    const target = path.join(outDir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(storage.absPath(key), target, { recursive: true });
    copied.push(path.relative(runDir, target).split(path.sep).join("/"));
  };
  for (const f of project.formats) await copy(rev.render(f), `${f}.mp4`);
  await copy(rev.poster, "poster.png");
  for (const f of FORMATS) await copy(rev.sheet(f), `sheets/${f}.png`);
  await copy(rev.storyboard, "storyboard.json");
  await copy(rev.qa, "qa.json");
  await copy(rev.check, "check.json");
  // Звук для порівняння з еталоном: зведення, план і метадані треку (з перевіркою).
  await copy(rev.publicFile(PUBLIC_MIX_FILE), "soundtrack.wav");
  await copy(rev.audioPlan, "audio-plan.json");
  // Звукорежисер і рецензент (режим designer): план SFX, відомість звуку зведення, рецензія.
  await copy(rev.sfxPlan, "sfx-plan.json");
  await copy(rev.soundSheet, "sound-sheet.json");
  await copy(rev.review, "review.json");
  const manifest = await readOptional(storage, rev.audio, (v) => AudioManifest.parse(v));
  if (manifest?.music) await copy(projectPaths(projectId).musicMeta(manifest.music.planHash), "music.json");
  if (project.brandkitVersion !== null)
    await copy(projectPaths(projectId).brandkit(project.brandkitVersion), "brandkit.json");
  const stillsDir = path.join(storage.absPath(rev.root), "stills");
  if (existsSync(stillsDir)) {
    await cp(stillsDir, path.join(outDir, "stills"), { recursive: true });
    copied.push(`sites/${name}/stills/`);
  }
  return copied;
}

// ───────────────────────────── звіт кейсу (паритет) ─────────────────────────────

/** Пороги паритету з ТЗ 2026-10-12 §8. */
export const PARITY = {
  /** Музика в міксі поза подіями, dBFS (не нижче). */
  musicMinDb: -16,
  /** Пік події над RMS музики, дБ (не вище). */
  eventMaxOverMusicDb: 6,
} as const;

/**
 * Цілі звуку з ТЗ якості звуку 2026-10-13 (§8): мастер зведення і моно-сумісність низу.
 * Ті самі числа — у `docs/analysis/README.md` (процедура заміру `pnpm audio-measure`).
 */
export const AUDIO_TARGETS = {
  /** Інтегральна гучність зведення, LUFS (BS.1770-4), і допуск ±. */
  lufs: -14,
  lufsTolerance: 1,
  /** True peak зведення, dBTP (не вище). */
  truePeakMaxDbtp: -1,
  /** Кореляція L/R нижче `lowBelowHz` у зведенні (не нижче). */
  lowCorrelationMin: 0.9,
  lowBelowHz: LOW_CORRELATION_HZ,
} as const;

/** Важкі удари (impact/slam/drop) на ролик: `1 + ⌊с / 6⌋` (25 с → 5), як ліміт нормалізації (A3). */
export const impactLimit = (seconds: number) => 1 + Math.floor(seconds / 6);

const DB_FLOOR = -120;
const toDb = (gain: number) => round(Math.max(DB_FLOOR, 20 * Math.log10(Math.max(gain, 1e-9))), 1);

export interface LevelStats {
  rmsDb: number;
  peakDb: number;
  /** 90-й перцентиль RMS у вікнах 100 мс (як у docs/analysis). */
  p90Rms100msDb: number;
  /** RMS по секундах (остання може бути неповною). */
  perSecondDb: number[];
}

/** Рівні доріжки, dBFS. */
export function levelStats(pcm: StereoPcm): LevelStats {
  const sr = pcm.sampleRate;
  const n = pcm.left.length;
  const win = Math.max(1, Math.round(sr / 10));
  const short: number[] = [];
  for (let a = 0; a < n; a += win) short.push(rmsOf(pcm, a, Math.min(n, a + win)));
  short.sort((x, y) => x - y);
  const perSecondDb: number[] = [];
  for (let a = 0; a < n; a += sr) perSecondDb.push(toDb(rmsOf(pcm, a, Math.min(n, a + sr))));
  return {
    rmsDb: toDb(rmsOf(pcm)),
    peakDb: toDb(peakOf(pcm)),
    p90Rms100msDb: toDb(short[Math.min(short.length - 1, Math.floor(short.length * 0.9))] ?? 0),
    perSecondDb,
  };
}

export interface BeatStats {
  bpm: number | null;
  /** Онсети в низах (бочка/бас), як у вирівнюванні долі. */
  onsets: number;
  onsetsPerBeat: number | null;
  /** 0..1: наскільки онсети лежать на сітці `bpm`. */
  confidence: number | null;
}

export function beatStats(pcm: StereoPcm, bpm: number | null): BeatStats {
  const onsets = lowBandOnsets(pcm);
  if (!bpm) return { bpm: null, onsets: onsets.length, onsetsPerBeat: null, confidence: null };
  const beats = (pcm.left.length / pcm.sampleRate) * (bpm / 60);
  return {
    bpm,
    onsets: onsets.length,
    onsetsPerBeat: beats > 0 ? round(onsets.length / beats, 2) : null,
    confidence: round(estimateBeatPhase(onsets, 60 / bpm).confidence, 2),
  };
}

export interface EventLevel {
  sceneId: string;
  eventId: string;
  cue: SoundCue;
  accent: string;
  atSec: number;
  /** Пік події над RMS музики за секунду до неї, дБ; null — події не чути. */
  overMusicDb: number | null;
}

export interface CaseAudio {
  /**
   * `stems` — зведення повторено з артефактів і побайтно збіглося з `soundtrack.wav`, метрики зі стемів;
   * `mix` — оцінка по готовому `soundtrack.wav` (музика й події разом); null — звуку немає.
   */
  source: "stems" | "mix" | null;
  /** Чому не стеми або чому метрик немає. */
  note: string | null;
  /** Готове зведення (`soundtrack.wav`). */
  mix: LevelStats | null;
  /** Бочка зведення на сітці темпу розкадровки. */
  beat: BeatStats | null;
  /** Мастер зведення з `audio.json` (`mix`): LUFS, true peak і підсилення; null — старе зведення без них. */
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  masterGainDb: number | null;
  /** Підсилення музики до рівня міксу (`Soundtrack.masterGain`, лише зі стемів); null — оцінка по міксу. */
  musicGainDb: number | null;
  /** Кореляція L/R низу (< 150 Гц) готового зведення — моно-сумісність басу; null — зведення немає. */
  mixLowCorrelation: number | null;
  /** Тональність плану (`audio-plan.json`) і визначена за треком (`music.json`, `check.keyDetected`). */
  keyPlanned: string | null;
  keyDetected: MusicTrackCheck["keyDetected"];
  /** З перевірки треку (`music.json`): впевненість такту, кореляція L/R усього треку і низу. */
  barConfidence: number | null;
  stereoCorrelation: number | null;
  lowCorrelation: number | null;
  /** Генерацій треку і зсув вікна треку, мс (`music.json`). */
  attempts: number | null;
  offsetMs: number | null;
  music: {
    rmsDb: number;
    perSecondDb: number[];
    /** Секунди без подій, поза частинами `filtered`/`breakdown` і без останньої (fade-out). */
    outsideEvents: { seconds: number[]; minDb: number | null; medianDb: number | null };
  } | null;
  events: { count: number; maxOverMusicDb: number | null; list: EventLevel[] } | null;
  /** Шина реверберації (з'являється у стемах зі зведенням v3). */
  reverb: { rmsDb: number } | null;
}

export interface CaseMusic {
  planHash: string | null;
  method: string | null;
  attempts: number | null;
  /** Зсув вибраного вікна треку, мс (A2); null — немає в music.json. */
  offsetMs: number | null;
  check: MusicTrackCheck | null;
  note: string | null;
}

export interface CaseStoryboard {
  scenes: number;
  seconds: number;
  events: number;
  withSound: number;
  cues: Record<string, number>;
  /** Важкі удари (impact/slam/drop, `HIT_SOUND_CUES`) у розкадровці. */
  impactSlam: number;
  impactSlamLimit: number;
  /** Найбільше важких ударів у будь-якому вікні 3 с. */
  impactSlamMaxIn3s: number;
  /** Чи є `breakdown` у структурі музики. */
  breakdown: boolean;
  items: number;
  roles: Record<string, number>;
}

export interface CaseCriterion {
  id: string;
  label: string;
  value: number | boolean | null;
  /** null — не виміряно автоматично (див. `note`). */
  ok: boolean | null;
  note: string | null;
}

export interface CaseReport {
  case: string;
  run: string;
  generatedAt: string;
  mode: GenerationMode;
  /** Режим звуку воркера eval — щоб порівнювати designer і storyboard на тих самих сайтах. */
  soundMode: SoundTuning;
  site: string;
  projectId: string;
  status: string;
  delivered: boolean;
  error: string | null;
  formats: Format[];
  videoSeconds: number | null;
  /** `project.durationSeconds` (тривалість, задана кейсом). */
  durationSeconds: number | null;
  cost: {
    usd: number;
    usdByStage: Array<{ key: string; usd: number }>;
    usdByProvider: Array<{ key: string; usd: number }>;
    llmCalls: number;
    tokens: { input: number; output: number; cacheWrite: number; cacheRead: number; total: number };
  };
  time: {
    wallMinutes: number;
    machineMinutes: number;
    /** Стадії прогону: скільки запусків і хвилин (видно, чи працював `author`). */
    stages: Array<{ stage: string; runs: number; minutes: number }>;
  };
  storyboard: CaseStoryboard | null;
  music: CaseMusic;
  audio: CaseAudio;
  /** `review.json` ревізії; null — рецензії не було. */
  review: CaseReview | null;
  /** `sound-sheet.json` ревізії; null — відомості немає. */
  sound: CaseSound | null;
  criteria: CaseCriterion[];
  files: string[];
}

interface EventPoint {
  sceneId: string;
  eventId: string;
  cue: SoundCue;
  accent: string;
  at: number;
  window: [number, number];
}

/** Події зі звуком у семплах; вікно чутності — як у зведенні (`audibilityWindow`: за якорем cue). */
function eventPoints(storyboard: Storyboard, sr: number): EventPoint[] {
  return computeEventPlacements(storyboard).flatMap((p) => {
    if (p.cue === null) return [];
    const at = Math.round((p.frame * sr) / storyboard.fps);
    const window = audibilityWindow(p.cue, at, sr);
    return [{ sceneId: p.sceneId, eventId: p.eventId, cue: p.cue, accent: p.accent, at, window }];
  });
}

/** Діапазони семплів сцен, де музика навмисно тихша (`filtered`, `breakdown`). */
function quietRanges(storyboard: Storyboard, sr: number): Array<[number, number]> {
  const mixOf = new Map<string, string>();
  for (const part of storyboard.musicBrief.structure) {
    for (const id of part.sceneIds) if (!mixOf.has(id)) mixOf.set(id, part.mix ?? "full");
  }
  const toSample = (frame: number) => Math.round((frame * sr) / storyboard.fps);
  return computeTimeline(storyboard)
    .scenes.filter((s) => (mixOf.get(s.id) ?? "full") !== "full")
    .map((s): [number, number] => [toSample(s.from), toSample(s.end)]);
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2, 1);
};

/**
 * Рівні музики поза подіями і піки подій над музикою.
 * `events` null — оцінка по міксу (пік події = пік міксу у вікні, зона події довша на хвіст семпла).
 */
function musicAndEvents(input: {
  music: StereoPcm;
  events: StereoPcm | null;
  /** Лінійний множник музики до рівня міксу (мастер). */
  gain: number;
  points: readonly EventPoint[];
  quiet: ReadonlyArray<[number, number]>;
  bpm: number;
}): Pick<CaseAudio, "music" | "events"> {
  const { music, events, gain, points, quiet } = input;
  const sr = music.sampleRate;
  const n = music.left.length;
  // Після події музика ще «відходить» (дакінг до 1¼ долі); у міксі ще й звучить хвіст семпла (≤ 2 с).
  const post = Math.round((events ? Math.max(1, (1.25 * 60) / input.bpm) : 2) * sr);
  const zones: Array<[number, number]> = points.map((p) => [
    p.window[0] - (!events && p.cue === "riser" ? 2 * sr : 0),
    p.at + post,
  ]);
  const overlaps = (a: number, b: number, ranges: ReadonlyArray<[number, number]>) =>
    ranges.some(([x, y]) => x < b && y > a);
  const perSecondDb: number[] = [];
  const outside: number[] = [];
  const outsideDb: number[] = [];
  const full = Math.floor(n / sr);
  for (let s = 0; s * sr < n; s++) {
    const a = s * sr;
    const b = Math.min(n, a + sr);
    const db = toDb(rmsOf(music, a, b) * gain);
    perSecondDb.push(db);
    if (s >= full - 1 || overlaps(a, b, zones) || overlaps(a, b, quiet)) continue;
    outside.push(s);
    outsideDb.push(db);
  }
  const whole = rmsOf(music);
  const list: EventLevel[] = points.map((p) => {
    const peak = peakOf(events ?? music, p.window[0], p.window[1]);
    const ref = rmsOf(music, p.at - sr, p.at) || whole;
    return {
      sceneId: p.sceneId,
      eventId: p.eventId,
      cue: p.cue,
      accent: p.accent,
      atSec: round(p.at / sr, 2),
      overMusicDb: peak > 0 && ref > 0 ? round(20 * Math.log10(peak / ref), 1) : null,
    };
  });
  const over = list.map((e) => e.overMusicDb).filter((v): v is number => v !== null);
  return {
    music: {
      rmsDb: toDb(whole * gain),
      perSecondDb,
      outsideEvents: {
        seconds: outside,
        minDb: outsideDb.length > 0 ? Math.min(...outsideDb) : null,
        medianDb: median(outsideDb),
      },
    },
    events: { count: list.length, maxOverMusicDb: over.length > 0 ? Math.max(...over) : null, list },
  };
}

export interface CaseAudioDeps {
  /** Декодер треку й семплів (дефолт — ffmpeg зі збірки Remotion, як у стадії `audio`). */
  decode?: DecodeAudio;
  /** Промпти (бібліотека SFX `elevenlabs/sfx-cues`); дефолт — репозиторні. */
  prompts?: PromptLoader;
}

type RenderedSoundtrack = ReturnType<typeof renderSoundtrack>;

/**
 * Повторює зведення стадії `audio` з артефактів прогону: трек (`public/music.*`), план (тональність),
 * семпли бібліотеки SFX з кешу і розкадровка → `renderSoundtrack` (чиста функція). Стеми в сховищі
 * не зберігаються, тож це єдиний спосіб отримати їх точно; збіг із `soundtrack.wav` перевіряється побайтно.
 */
async function rerenderSoundtrack(
  storage: Storage,
  projectId: string,
  rev: number,
  storyboard: Storyboard,
  deps: CaseAudioDeps,
): Promise<{ soundtrack: RenderedSoundtrack } | { reason: string }> {
  const paths = projectPaths(projectId);
  const revPaths = paths.rev(rev);
  const manifest = await readOptional(storage, revPaths.audio, (v) => AudioManifest.parse(v));
  const candidates = [
    revPaths.publicFile(PUBLIC_MUSIC_FILE),
    ...(manifest?.music ? [paths.music(manifest.music.planHash)] : []),
  ];
  let musicKey: string | null = null;
  for (const key of candidates) {
    if (await storage.exists(key)) {
      musicKey = key;
      break;
    }
  }
  if (!musicKey) return { reason: "немає файлу треку — стеми не відтворити" };
  const plan = await readOptional(storage, revPaths.audioPlan, (v) => v as { key?: unknown });
  const key = typeof plan?.key === "string" ? plan.key : null;
  const decode = deps.decode ?? decodeAudio;
  const library = loadSfxLibrary(deps.prompts ?? createPromptLoader());
  const cues = [
    ...new Set(
      computeEventPlacements(storyboard)
        .map((p) => p.cue)
        .filter((c): c is SoundCue => c !== null),
    ),
  ];
  const samples: Partial<Record<SoundCue, SfxSample[]>> = {};
  for (const cue of cues) {
    for (const [i, def] of (library[cue] ?? []).entries()) {
      const hash = sfxHash(def);
      // Кеш — `.mp3` або `.wav` (PCM-формат, A1).
      let cacheKey = sfxCacheKey(hash, "mp3");
      if (!(await storage.exists(cacheKey))) cacheKey = sfxCacheKey(hash, "wav");
      if (!(await storage.exists(cacheKey))) continue;
      try {
        const pcm = await decode(await storage.read(cacheKey));
        samples[cue] = [...(samples[cue] ?? []), { cue, variant: i + 1, hash, pcm }];
      } catch {
        // Як у стадії: варіант, що не декодувався, пропускається.
      }
    }
  }
  const music = await decode(await storage.read(musicKey));
  return { soundtrack: renderSoundtrack({ music, storyboard, key, samples }) };
}

type AudioFeedback = Pick<
  CaseAudio,
  | "integratedLufs"
  | "truePeakDbtp"
  | "masterGainDb"
  | "keyPlanned"
  | "keyDetected"
  | "barConfidence"
  | "stereoCorrelation"
  | "lowCorrelation"
  | "attempts"
  | "offsetMs"
>;

/**
 * Зворотний зв'язок звуку без декодування: мастер з `audio.json`, тональність плану з `audio-plan.json`,
 * перевірка треку з `music.json`. Чого немає (старі ревізії, трек не перевірявся) — null.
 */
async function audioFeedback(storage: Storage, projectId: string, rev: number): Promise<AudioFeedback> {
  const revPaths = projectPaths(projectId).rev(rev);
  const manifest = await readOptional(storage, revPaths.audio, (v) => AudioManifest.parse(v));
  const plan = await readOptional(storage, revPaths.audioPlan, (v) => v as { key?: unknown });
  const music = await caseMusic(storage, projectId, rev);
  const check = music.check;
  return {
    integratedLufs: manifest?.mix?.integratedLufs ?? null,
    truePeakDbtp: manifest?.mix?.truePeakDbtp ?? null,
    masterGainDb: manifest?.mix?.masterGainDb ?? null,
    keyPlanned: typeof plan?.key === "string" ? plan.key : null,
    keyDetected: check?.keyDetected ?? null,
    barConfidence: check?.barConfidence ?? null,
    stereoCorrelation: check?.stereoCorrelation ?? null,
    lowCorrelation: check?.lowCorrelation ?? null,
    attempts: music.attempts,
    offsetMs: music.offsetMs,
  };
}

/** Звукові метрики кейсу: стеми (якщо зведення відтворилось побайтно), інакше оцінка по міксу. */
export async function measureCaseAudio(
  storage: Storage,
  projectId: string,
  rev: number,
  storyboard: Storyboard | null,
  deps: CaseAudioDeps = {},
): Promise<CaseAudio> {
  const empty: CaseAudio = {
    source: null,
    note: null,
    mix: null,
    beat: null,
    ...(await audioFeedback(storage, projectId, rev)),
    musicGainDb: null,
    mixLowCorrelation: null,
    music: null,
    events: null,
    reverb: null,
  };
  const mixKey = projectPaths(projectId).rev(rev).publicFile(PUBLIC_MIX_FILE);
  if (!(await storage.exists(mixKey)))
    return { ...empty, note: `немає ${PUBLIC_MIX_FILE} — зведення не було` };
  const saved = await storage.read(mixKey);
  let mix: StereoPcm;
  try {
    mix = decodeWav(saved);
  } catch (err) {
    return { ...empty, note: `${PUBLIC_MIX_FILE} не читається: ${(err as Error).message}` };
  }
  const base: CaseAudio = {
    ...empty,
    mix: levelStats(mix),
    beat: beatStats(mix, storyboard?.musicBrief.bpm ?? null),
    mixLowCorrelation: round(correlation(mix, AUDIO_TARGETS.lowBelowHz), 3),
  };
  if (!storyboard) return { ...base, note: "немає розкадровки — події невідомі" };
  const sr = mix.sampleRate;
  const points = eventPoints(storyboard, sr);
  const quiet = quietRanges(storyboard, sr);
  const bpm = storyboard.musicBrief.bpm;

  let reason: string;
  try {
    const res = await rerenderSoundtrack(storage, projectId, rev, storyboard, deps);
    if ("soundtrack" in res && res.soundtrack.wav.equals(saved)) {
      // Стеми v2: music, events; зі зведенням v3 (A1) додається reverb. masterGain (музики) — якщо є.
      const st = res.soundtrack as unknown as {
        masterGain?: unknown;
        stems: { music: StereoPcm; events: StereoPcm; reverb?: StereoPcm };
      };
      const gain = typeof st.masterGain === "number" ? st.masterGain : 1;
      return {
        ...base,
        source: "stems",
        musicGainDb: round(20 * Math.log10(Math.max(gain, 1e-9)), 1),
        ...musicAndEvents({ music: st.stems.music, events: st.stems.events, gain, points, quiet, bpm }),
        reverb: st.stems.reverb ? { rmsDb: toDb(rmsOf(st.stems.reverb) * gain) } : null,
      };
    }
    reason =
      "reason" in res
        ? res.reason
        : "повторне зведення не збіглося з soundtrack.wav (змінились семпли, промпти SFX або алгоритм)";
  } catch (err) {
    reason = `стеми не відтворились: ${(err as Error).message}`;
  }
  return {
    ...base,
    source: "mix",
    note: `${reason}; оцінка по міксу`,
    ...musicAndEvents({ music: mix, events: null, gain: 1, points, quiet, bpm }),
  };
}

/** Перевірка треку з `audio/<hash>/music.json` (A2: `check`, `attempts`, `offsetMs`). */
async function caseMusic(storage: Storage, projectId: string, rev: number): Promise<CaseMusic> {
  const paths = projectPaths(projectId);
  const empty: CaseMusic = {
    planHash: null,
    method: null,
    attempts: null,
    offsetMs: null,
    check: null,
    note: null,
  };
  const manifest = await readOptional(storage, paths.rev(rev).audio, (v) => AudioManifest.parse(v));
  const planHash = manifest?.music?.planHash ?? null;
  if (!planHash) return { ...empty, note: "немає audio.json з треком" };
  const raw = await readOptional(storage, paths.musicMeta(planHash), (v) => v);
  if (raw === null) return { ...empty, planHash, note: "немає music.json" };
  const meta = MusicMeta.safeParse(raw);
  if (!meta.success) return { ...empty, planHash, note: "music.json не за схемою MusicMeta" };
  const offset = (raw as { offsetMs?: unknown }).offsetMs;
  return {
    planHash,
    method: meta.data.method,
    attempts: meta.data.attempts,
    offsetMs: typeof offset === "number" ? offset : null,
    check: meta.data.check,
    note: meta.data.check ? null : "трек не перевірявся (music.json без check)",
  };
}

export function storyboardStats(storyboard: Storyboard): CaseStoryboard {
  const seconds = computeTimeline(storyboard).durationSeconds;
  const placements = computeEventPlacements(storyboard);
  const cues: Record<string, number> = {};
  for (const p of placements) if (p.cue) cues[p.cue] = (cues[p.cue] ?? 0) + 1;
  const hits = placements
    .filter((p) => p.cue !== null && HIT_SOUND_CUES.has(p.cue))
    .map((p) => p.frame / storyboard.fps);
  let maxIn3s = 0;
  for (const t of hits) maxIn3s = Math.max(maxIn3s, hits.filter((u) => u >= t && u < t + 3).length);
  const roles: Record<string, number> = {};
  for (const scene of storyboard.scenes) {
    for (const item of scene.items) roles[item.role] = (roles[item.role] ?? 0) + 1;
  }
  return {
    scenes: storyboard.scenes.length,
    seconds: round(seconds, 2),
    events: placements.length,
    withSound: placements.filter((p) => p.cue !== null).length,
    cues,
    impactSlam: hits.length,
    impactSlamLimit: impactLimit(seconds),
    impactSlamMaxIn3s: maxIn3s,
    breakdown: storyboard.musicBrief.structure.some((p) => p.mix === "breakdown"),
    items: storyboard.scenes.reduce((a, s) => a + s.items.length, 0),
    roles,
  };
}

const MANUAL = "вручну за docs/analysis/README.md (контакт-лист 1 fps)";

export function caseCriteria(
  audio: CaseAudio,
  music: CaseMusic,
  storyboard: CaseStoryboard | null,
): CaseCriterion[] {
  const musicMin = audio.music?.outsideEvents.minDb ?? null;
  const overMax = audio.events?.maxOverMusicDb ?? null;
  const est = audio.source === "mix" ? "оцінка по міксу" : null;
  const t = AUDIO_TARGETS;
  const noMaster = "немає в audio.json (зведення до ТЗ звуку або не вдалося)";
  return [
    {
      id: "music_level",
      label: `Музика в міксі ≥ ${PARITY.musicMinDb} dBFS поза подіями`,
      value: musicMin,
      ok: musicMin === null ? null : musicMin >= PARITY.musicMinDb,
      note: musicMin === null ? (audio.note ?? "немає секунд без подій") : est,
    },
    {
      id: "event_peaks",
      label: `Піки подій ≤ +${PARITY.eventMaxOverMusicDb} дБ над музикою`,
      value: overMax,
      ok: overMax === null ? null : overMax <= PARITY.eventMaxOverMusicDb,
      note: overMax === null ? (audio.note ?? "немає подій зі звуком") : est,
    },
    {
      id: "loudness",
      label: `Гучність зведення ${t.lufs} ±${t.lufsTolerance} LUFS`,
      value: audio.integratedLufs,
      ok: audio.integratedLufs === null ? null : Math.abs(audio.integratedLufs - t.lufs) <= t.lufsTolerance,
      note: audio.integratedLufs === null ? noMaster : null,
    },
    {
      id: "true_peak",
      label: `True peak зведення ≤ ${t.truePeakMaxDbtp} dBTP`,
      value: audio.truePeakDbtp,
      ok: audio.truePeakDbtp === null ? null : audio.truePeakDbtp <= t.truePeakMaxDbtp,
      note: audio.truePeakDbtp === null ? noMaster : null,
    },
    {
      id: "low_mono",
      label: `Низ зведення (< ${t.lowBelowHz} Гц) моно: кореляція L/R ≥ ${t.lowCorrelationMin}`,
      value: audio.mixLowCorrelation,
      ok: audio.mixLowCorrelation === null ? null : audio.mixLowCorrelation >= t.lowCorrelationMin,
      note: audio.mixLowCorrelation === null ? (audio.note ?? "немає зведення") : null,
    },
    {
      id: "music_check",
      label: "MusicTrackCheck.ok",
      value: music.check?.ok ?? null,
      ok: music.check?.ok ?? null,
      note: music.note,
    },
    {
      id: "impact_count",
      label: `impact/slam/drop у розкадровці ≤ ${storyboard?.impactSlamLimit ?? "1 + ⌊с/6⌋"}`,
      value: storyboard?.impactSlam ?? null,
      ok: storyboard ? storyboard.impactSlam <= storyboard.impactSlamLimit : null,
      note: storyboard ? null : "немає розкадровки",
    },
    {
      id: "product_in_frame",
      label: "У кадрі категорії перевірки і приклад результату з реальними рядками",
      value: null,
      ok: null,
      note: MANUAL,
    },
    { id: "live_background", label: "Фон живий у кожній сцені", value: null, ok: null, note: MANUAL },
    {
      id: "layout_variety",
      label: "Жодні дві сусідні сцени не повторюють макет",
      value: null,
      ok: null,
      note: MANUAL,
    },
  ];
}

const isTokens = (u: CostEvent["units"]): u is Extract<CostEvent["units"], { input: number }> => "input" in u;

/** Звіт кейсу: витрати й час з `since`, звук, трек, розкадровка і критерії паритету. */
export async function buildCaseReport(
  storage: Storage,
  projectId: string,
  meta: {
    caseName: string;
    run: string;
    since: Date;
    site: SiteReport;
    mode: GenerationMode;
    /** Дефолт — `currentSoundTuning()` (env). */
    soundMode?: SoundTuning;
    now?: Date;
  } & CaseAudioDeps,
): Promise<CaseReport> {
  const paths = projectPaths(projectId);
  const project = await readOptional(storage, paths.project, (v) => ProjectStateSchema.parse(v));
  const rev = project?.rev ?? 1;
  const storyboard = await readOptional(storage, paths.rev(rev).storyboard, (v) => Storyboard.parse(v));
  const sinceIso = meta.since.toISOString();
  const costs = (await readCosts(storage, projectId)).filter((e) => e.ts >= sinceIso);
  const trace: TraceEntry[] = (await readTrace(storage, projectId)).filter((t) => t.startedAt >= sinceIso);

  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
  for (const e of costs) {
    if (!isTokens(e.units)) continue;
    tokens.input += e.units.input;
    tokens.output += e.units.output;
    tokens.cacheWrite += e.units.cacheWrite + e.units.cacheWrite1h;
    tokens.cacheRead += e.units.cacheRead;
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead;

  const byStage = new Map<string, { runs: number; ms: number }>();
  for (const t of trace) {
    const cur = byStage.get(t.stage) ?? { runs: 0, ms: 0 };
    byStage.set(t.stage, { runs: cur.runs + 1, ms: cur.ms + t.durationMs });
  }
  const minutes = (ms: number) => round(ms / 60_000, 2);

  const deps: CaseAudioDeps = {
    ...(meta.decode ? { decode: meta.decode } : {}),
    ...(meta.prompts ? { prompts: meta.prompts } : {}),
  };
  const audio = await measureCaseAudio(storage, projectId, rev, storyboard, deps);
  const music = await caseMusic(storage, projectId, rev);
  const sb = storyboard ? storyboardStats(storyboard) : null;
  const { review, sound } = await readReviewAndSound(storage, projectId, rev);
  const s = meta.site;
  return {
    case: meta.caseName,
    run: meta.run,
    generatedAt: (meta.now ?? new Date()).toISOString(),
    mode: meta.mode,
    soundMode: meta.soundMode ?? currentSoundTuning(),
    site: s.site,
    projectId,
    status: s.status,
    delivered: s.delivered,
    error: s.error,
    formats: s.formats,
    videoSeconds: s.videoSeconds,
    durationSeconds: project?.durationSeconds ?? null,
    cost: {
      usd: s.usd,
      usdByStage: s.usdByStage,
      usdByProvider: s.usdByProvider,
      llmCalls: s.llmCalls,
      tokens,
    },
    time: {
      wallMinutes: round(s.wallSeconds / 60, 2),
      machineMinutes: minutes(trace.reduce((a, t) => a + t.durationMs, 0)),
      stages: [...byStage.entries()].map(([stage, v]) => ({ stage, runs: v.runs, minutes: minutes(v.ms) })),
    },
    storyboard: sb,
    music,
    audio,
    review,
    sound,
    criteria: caseCriteria(audio, music, sb),
    files: s.files,
  };
}

const dbStr = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v} дБ`);
const okStr = (v: boolean | null) => (v === null ? "—" : v ? "так" : "НІ");
const orDash = (v: number | string | null) => (v === null ? "—" : String(v));
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;
/** `check.keyDetected` → «A minor (0.42)». */
const keyStr = (k: CaseAudio["keyDetected"]) =>
  k ? `${NOTE_NAMES[k.root] ?? "?"} ${k.minor ? "minor" : "major"} (${round(k.confidence, 2)})` : "—";

export function caseReportMarkdown(r: CaseReport): string {
  const a = r.audio;
  const sb = r.storyboard;
  const lines = [
    `# Кейс ${r.case} — ${r.mode}`,
    "",
    `Прогін ${r.run}, проєкт \`${r.projectId}\`, ${r.site}. Статус: ${r.status}${r.error ? ` — ${r.error}` : ""}.`,
    "",
    "| Метрика | Значення |",
    "|---|---|",
    `| Режим генерації | ${r.mode} |`,
    `| Режим звуку | ${soundModeStr(r.soundMode)} |`,
    `| Формати / відео | ${r.formats.map((f) => FORMAT_LABEL[f]).join(", ") || "—"} / ${sec(r.videoSeconds)} (задано ${r.durationSeconds ?? "—"} с) |`,
    `| Витрачено | ${usd(r.cost.usd)} (${r.cost.llmCalls} викликів LLM) |`,
    `| Токени: input / output / cache write / cache read | ${r.cost.tokens.input} / ${r.cost.tokens.output} / ${r.cost.tokens.cacheWrite} / ${r.cost.tokens.cacheRead} |`,
    `| Хвилини: настінні / машинні | ${r.time.wallMinutes} / ${r.time.machineMinutes} |`,
    `| Стадії | ${r.time.stages.map((s) => `${s.stage}×${s.runs} ${s.minutes} хв`).join(", ") || "—"} |`,
    `| impact/slam/drop (ліміт) | ${sb ? `${sb.impactSlam} (${sb.impactSlamLimit}), макс. у 3 с: ${sb.impactSlamMaxIn3s}` : "—"} |`,
    `| Мікс: RMS / пік / p90 100 мс | ${a.mix ? `${a.mix.rmsDb} / ${a.mix.peakDb} / ${a.mix.p90Rms100msDb} dBFS` : "—"} |`,
    `| Бочка на сітці | ${a.beat?.bpm ? `${a.beat.onsets} онсетів, ${a.beat.onsetsPerBeat}/долю, впевненість ${a.beat.confidence} при ${a.beat.bpm} BPM` : "—"} |`,
    `| Звук — джерело метрик | ${a.source ?? "—"}${a.note ? ` (${a.note})` : ""} |`,
    `| Музика поза подіями: мін / медіана | ${a.music ? `${a.music.outsideEvents.minDb ?? "—"} / ${a.music.outsideEvents.medianDb ?? "—"} dBFS` : "—"} |`,
    `| Пік подій над музикою, макс | ${dbStr(a.events?.maxOverMusicDb ?? null)} |`,
    `| Трек: перевірка / спроб / зсув | ${r.music.check ? `ok=${r.music.check.ok}, провалів ${r.music.check.gaps.length}` : (r.music.note ?? "—")} / ${r.music.attempts ?? "—"} / ${r.music.offsetMs ?? "—"} мс |`,
    `| Мастер: LUFS / dBTP / підсилення | ${orDash(a.integratedLufs)} / ${orDash(a.truePeakDbtp)} / ${dbStr(a.masterGainDb)} |`,
    `| Тональність: план / трек | ${a.keyPlanned ?? "—"} / ${keyStr(a.keyDetected)} |`,
    `| Трек: такт / кореляція L/R / низ; зведення: низ | ${orDash(a.barConfidence)} / ${orDash(a.stereoCorrelation)} / ${orDash(a.lowCorrelation)}; ${orDash(a.mixLowCorrelation)} |`,
    "",
    "## Звук і рецензія",
    "",
    ...SOUND_REVIEW_HEAD,
    `| ${soundReviewRow(r.case, r.review, r.sound)} |`,
    "",
    SOUND_REVIEW_NOTE,
    ...(r.review
      ? ["", `Рецензент (коло ${r.review.round}): ${r.review.summary.replaceAll("\n", " ") || "—"}`]
      : []),
    "",
    "## Критерії паритету",
    "",
    "| Критерій | Значення | Виконано | Примітка |",
    "|---|---|---|---|",
    ...r.criteria.map(
      (c) => `| ${c.label} | ${c.value ?? "—"} | ${okStr(c.ok)} | ${(c.note ?? "").replaceAll("|", "/")} |`,
    ),
    "",
    "## RMS по секундах, dBFS",
    "",
    `- мікс: ${a.mix?.perSecondDb.join(", ") ?? "—"}`,
    `- музика${a.source === "mix" ? " (мікс)" : ""}: ${a.music?.perSecondDb.join(", ") ?? "—"}`,
    "",
  ];
  return lines.join("\n");
}

/** `--audio`: рівні й бочка будь-якої доріжки (WAV напряму, інше — через ffmpeg). */
export async function measureAudioFile(
  file: string,
  bpm: number | null,
  decode: DecodeAudio = decodeAudio,
): Promise<{ file: string; seconds: number; levels: LevelStats; beat: BeatStats }> {
  const bytes = await readFile(file);
  let pcm: StereoPcm;
  try {
    pcm = decodeWav(bytes);
  } catch {
    pcm = await decode(bytes);
  }
  return {
    file,
    seconds: round(pcm.left.length / pcm.sampleRate, 2),
    levels: levelStats(pcm),
    beat: beatStats(pcm, bpm),
  };
}

// ───────────────────────────── прогін ─────────────────────────────

export interface EvalDeps {
  /** Клієнт Anthropic (дефолт — справжній, з ANTHROPIC_API_KEY). */
  anthropic?: AnthropicLike | (() => AnthropicLike);
  /** Реєстр стадій (дефолт — справжній з @adc/worker). */
  registry?: StageRegistry;
  logger?: Logger;
  /** Куди писати повідомлення для людини (дефолт — console.log). */
  print?: (line: string) => void;
  now?: () => Date;
  /** Декодер аудіо для звіту кейсу і `--audio` (дефолт — ffmpeg зі збірки Remotion). */
  decode?: DecodeAudio;
}

interface Target {
  name: string;
  /** Ім'я кейсу (`name` сайту в списку) — тека звіту кейсу. */
  caseName: string;
  projectId: string;
  formats: Format[] | null;
  language: "uk" | "en" | null;
  start: (h: Harness) => Promise<void>;
}

/** Звіт кейсу → `<caseOut>/<кейс>/report.{json,md}` і копія в `sites/<сайт>/case-report.json` прогону. */
async function writeCaseReport(
  storage: Storage,
  o: {
    target: Target;
    site: SiteReport;
    since: Date;
    caseOut: string;
    runDir: string;
    print: (line: string) => void;
    now: () => Date;
    run: string;
    mode: GenerationMode;
    soundMode: SoundTuning;
    decode?: DecodeAudio;
  },
): Promise<void> {
  try {
    const report = await buildCaseReport(storage, o.target.projectId, {
      caseName: o.target.caseName,
      run: o.run,
      since: o.since,
      site: o.site,
      mode: o.mode,
      soundMode: o.soundMode,
      now: o.now(),
      ...(o.decode ? { decode: o.decode } : {}),
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const caseDir = path.join(o.caseOut, slugify(o.target.caseName));
    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "report.json"), json, "utf8");
    await writeFile(path.join(caseDir, "report.md"), caseReportMarkdown(report), "utf8");
    const siteDir = path.join(o.runDir, "sites", o.target.name);
    await mkdir(siteDir, { recursive: true });
    await writeFile(path.join(siteDir, "case-report.json"), json, "utf8");
    o.print(`  [${o.target.name}] звіт кейсу: ${path.join(caseDir, "report.md")}`);
  } catch (err) {
    o.print(`  [${o.target.name}] звіт кейсу не записано: ${(err as Error).message}`);
  }
}

async function runTargets(
  harness: Harness,
  targets: readonly Target[],
  args: EvalArgs,
  runDir: string,
  print: (line: string) => void,
  now: () => Date,
  cases: { run: string; mode: GenerationMode; soundMode: SoundTuning; decode?: DecodeAudio },
): Promise<SiteReport[]> {
  const reports: SiteReport[] = new Array(targets.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      const target = targets[i];
      if (!target) return;
      const since = now();
      // У режимі --only чекпоінти не затверджуються: прогін зупиняється там, де зупинився етап.
      const unsubscribe = args.only
        ? () => {}
        : autoApprove(harness, {
            formats: target.formats,
            language: target.language,
            projects: (id) => id === target.projectId,
            onApprove: (_id, checkpoint, rev) =>
              print(`  [${target.name}] чекпоінт ${checkpoint} (rev ${rev}) — затверджено`),
          });
      const offState = harness.events.on((pid, ev) => {
        if (pid === target.projectId && ev.type === "state")
          print(`  [${target.name}] ${ev.prev ?? "—"} → ${ev.status}`);
      });
      let error: string | null = null;
      try {
        await target.start(harness);
        // У режимі --only пайплайн зупиняється сам (решта job відкинута) — waitForStatus повертає стан.
        const status = await harness.waitForStatus(
          target.projectId,
          ["delivered", "failed"],
          args.timeoutMinutes * 60_000,
        );
        if (!args.only && status !== "delivered" && status !== "failed") {
          error = `пайплайн зупинився у стані ${status}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        unsubscribe();
        offState();
      }
      const wallSeconds = (now().getTime() - since.getTime()) / 1000;
      const files = await collectArtifacts(harness.storage, target.projectId, runDir, target.name).catch(
        () => [],
      );
      reports[i] = await buildSiteReport(harness.storage, target.projectId, {
        name: target.name,
        since,
        wallSeconds,
        files,
        error,
      });
      const r = reports[i] as SiteReport;
      await writeCaseReport(harness.storage, {
        target,
        site: r,
        since,
        caseOut: args.caseOut,
        runDir,
        print,
        now,
        ...cases,
      });
      print(
        `[${target.name}] ${r.status}${r.error ? ` (${r.error})` : ""}: ${usd(r.usd)}, ${sec(r.wallSeconds)}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.parallel, targets.length) }, worker));
  return reports;
}

/** Точка входу `pnpm eval`. Повертає код виходу. */
export async function runEvalCli(argv: readonly string[], deps: EvalDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  let args: EvalArgs;
  try {
    args = parseEvalArgs(argv);
  } catch (err) {
    print(`eval: ${(err as Error).message}\n\n${EVAL_USAGE}`);
    return 2;
  }
  if (args.help) {
    print(EVAL_USAGE);
    return 0;
  }
  if (args.audio) {
    try {
      const m = await measureAudioFile(args.audio, args.bpm, deps.decode);
      print(JSON.stringify(m, null, 2));
      return 0;
    } catch (err) {
      print(`eval: --audio ${args.audio}: ${(err as Error).message}`);
      return 2;
    }
  }

  // Що проганяємо: сайти зі списку або проєкти збереженого прогону.
  let sites: EvalSite[] = [];
  let baseDataDir: string | null = null;
  if (args.from) {
    baseDataDir = path.join(args.runsDir, args.run as string, "data");
    if (!existsSync(path.join(baseDataDir, "projects"))) {
      print(`eval: прогін «${args.run}» не знайдено (${baseDataDir})`);
      return 2;
    }
  } else {
    try {
      sites = await loadSites(args.sites);
    } catch (err) {
      print(`eval: ${(err as Error).message}`);
      return 2;
    }
    if (args.caseName) {
      const found = sites.filter((site) => site.name === args.caseName);
      if (found.length === 0) {
        print(
          `eval: кейс «${args.caseName}» не знайдено в ${args.sites}. ` +
            `Є: ${sites.map((site) => site.name).join(", ") || "—"}`,
        );
        return 2;
      }
      sites = found;
    }
    if (sites.length === 0) {
      print(
        `eval: список порожній — у ${path.relative(process.cwd(), args.sites) || args.sites} немає сайтів. ` +
          "Додайте URL (див. eval/README.md) і запустіть знову.",
      );
      return 0;
    }
  }

  if (!deps.anthropic) {
    loadRootEnv();
    if (!process.env.ANTHROPIC_API_KEY || !process.env.ELEVENLABS_API_KEY) {
      print(
        "eval: потрібні ANTHROPIC_API_KEY і ELEVENLABS_API_KEY у кореневому .env — eval ходить у платні API.",
      );
      return 2;
    }
  }
  // Невалідні ADC_* (зокрема ADC_SFX_MODE / ADC_FILM_REVIEW) — до старту прогону, а не падінням воркера.
  try {
    readTuning(args.mode ? { ...process.env, [TUNING_ENV.generationMode]: args.mode } : process.env);
  } catch (err) {
    print(`eval: ${(err as Error).message}`);
    return 2;
  }

  const startedAt = now();
  const run = runName(startedAt, args.runsDir, args.from ? `.from-${args.from}` : "");
  const runDir = path.join(args.runsDir, run);
  const dataDir = path.join(runDir, "data");
  await mkdir(dataDir, { recursive: true });
  if (baseDataDir) await cp(baseDataDir, dataDir, { recursive: true });
  print(`eval: прогін ${run} → ${runDir}`);

  // Режим генерації — env воркера eval на час прогону (відкат — після harness.close()).
  const restoreMode = applyGenerationMode(args.mode);
  const mode = currentGenerationMode();
  print(`eval: режим генерації ${mode}`);
  // Режим звуку — з env (ADC_SFX_MODE, ADC_FILM_REVIEW): воркер читає його сам на кожен крок.
  const soundMode = currentSoundTuning();
  print(`eval: звук ${soundModeStr(soundMode)}`);

  // Імена кейсів перезапуску — з report.json базового прогону (без префікса «01-»).
  const baseNames = new Map<string, string>();
  if (args.from) {
    try {
      const base = JSON.parse(
        await readFile(path.join(args.runsDir, args.run as string, "report.json"), "utf8"),
      ) as { sites?: Array<{ projectId?: unknown; name?: unknown }> };
      for (const site of base.sites ?? []) {
        if (typeof site.projectId === "string" && typeof site.name === "string") {
          baseNames.set(site.projectId, site.name.replace(/^\d+-/, ""));
        }
      }
    } catch {
      // Немає звіту базового прогону — кейс називається за доменом.
    }
  }

  const only = args.only ? args.from : null;
  const harness = createHarness({
    dataDir,
    anthropic: deps.anthropic ?? (() => createAnthropicClient()),
    ...(deps.registry ? { registry: deps.registry } : {}),
    logger: deps.logger ?? noopLogger,
    now,
    ...(only ? { filter: (job: StageJob) => job.stage === only } : {}),
  });

  const targets: Target[] = [];
  if (args.from) {
    const ids = (await readdir(path.join(dataDir, "projects"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const projectId of ids) {
      const project = await readOptional(harness.storage, projectPaths(projectId).project, (v) =>
        ProjectStateSchema.parse(v),
      );
      if (!project) continue;
      const name = slugify(project.input.url ?? projectId);
      const stage = args.from;
      targets.push({
        name,
        caseName: baseNames.get(projectId) ?? name,
        projectId,
        formats: null,
        language: null,
        start: async (h) => {
          const jobs = await prepareRerun(h.storage, projectId, stage, now(), soundMode.sfxMode);
          for (const job of jobs) await h.queue.enqueueStage(job);
        },
      });
    }
  } else {
    const used = new Set<string>();
    for (const [i, site] of sites.entries()) {
      let name = `${String(i + 1).padStart(2, "0")}-${slugify(site.name)}`;
      while (used.has(name)) name = `${name}-x`;
      used.add(name);
      const projectId = newProjectId();
      targets.push({
        name,
        caseName: site.name,
        projectId,
        formats: site.formats,
        language: site.language,
        start: async (h) => {
          const photos = await Promise.all(
            site.photos.map(async (p) => ({ name: path.basename(p), data: await readFile(p) })),
          );
          await h.createProject({
            id: projectId,
            url: site.url,
            manualText: site.text,
            photos,
            origin: "eval",
            durationSeconds: site.durationSeconds,
          });
        },
      });
    }
  }

  let reports: SiteReport[];
  try {
    reports = await runTargets(harness, targets, args, runDir, print, now, {
      run,
      mode,
      soundMode,
      ...(deps.decode ? { decode: deps.decode } : {}),
    });
    await harness.close();
  } finally {
    restoreMode();
  }

  const report: EvalReport = {
    run,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    mode,
    soundMode,
    from: args.from,
    baseRun: args.run,
    only: args.only,
    sites: reports,
    summary: summarize(reports),
  };
  await writeFile(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "report.md"), reportMarkdown(report), "utf8");
  const errors = harness.queue.errors;
  if (errors.length > 0) {
    await writeFile(path.join(runDir, "harness-errors.json"), `${JSON.stringify(errors, null, 2)}\n`, "utf8");
  }
  const s = report.summary;
  print(
    `eval: готово ${s.delivered}/${s.sites}, витрачено ${usd(s.totalUsd)}` +
      (s.usdPerDelivered.mean !== null ? `, у середньому ${usd(s.usdPerDelivered.mean)} за відео` : "") +
      `. Звіт: ${path.join(runDir, "report.md")}`,
  );
  return 0;
}
