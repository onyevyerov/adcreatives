import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type JobRecord, PipeState } from "@adc/pipeline";
import {
  type AnthropicLike,
  createAnthropicClient,
  distribution,
  FORMATS,
  type Format,
  findRepoRoot,
  groupUsd,
  type Logger,
  loadRootEnv,
  makeJobId,
  noopLogger,
  type ProjectState,
  ProjectState as ProjectStateSchema,
  projectPaths,
  projectStatsRow,
  QaReport,
  readCosts,
  readTrace,
  type StageJob,
  type StageName,
  type Storage,
  Storyboard,
  sumUsd,
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
    };
  });
}

// ───────────────────────────── аргументи ─────────────────────────────

/** Етапи, з яких можна перезапустити прогін (`crawl` — це просто новий прогін). */
export const RERUN_STAGES = ["brandkit", "storyboard", "codegen", "check", "qa", "audio", "render"] as const;
export type RerunStage = (typeof RERUN_STAGES)[number];

export interface EvalArgs {
  sites: string;
  runsDir: string;
  from: RerunStage | null;
  run: string | null;
  only: boolean;
  parallel: number;
  timeoutMinutes: number;
  help: boolean;
}

export const EVAL_USAGE = `Використання:
  pnpm eval                                 прогін по eval/sites.json → eval/runs/<дата>/
  pnpm eval --from <етап> --run <прогін>    перезапуск етапу зі збережених даних прогону
Опції:
  --sites <файл>       список сайтів (дефолт eval/sites.json)
  --out <тека>         де лежать прогони (дефолт eval/runs)
  --from <етап>        ${RERUN_STAGES.join(" | ")}
  --run <прогін>       тека в eval/runs/, з якої брати дані (для --from)
  --only               лише цей етап, без подальших
  --parallel <n>       скільки сайтів одночасно (дефолт 1)
  --timeout <хв>       ліміт на сайт (дефолт 60)`;

export function parseEvalArgs(argv: readonly string[], root: string = findRepoRoot()): EvalArgs {
  const args: EvalArgs = {
    sites: path.join(root, "eval", "sites.json"),
    runsDir: path.join(root, "eval", "runs"),
    from: null,
    run: null,
    only: false,
    parallel: 1,
    timeoutMinutes: 60,
    help: false,
  };
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

// ───────────────────────────── перезапуск етапу ─────────────────────────────

/**
 * Готує проєкт збереженого прогону до перезапуску етапу: стан і `pipeline.json` поточної ревізії
 * виставляються так, ніби оркестратор щойно поставив цей job (далі все йде звичайним шляхом).
 * Повертає job, які треба поставити в чергу.
 */
export async function prepareRerun(
  storage: Storage,
  projectId: string,
  stage: RerunStage,
  now: Date = new Date(),
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
  if (["codegen", "check", "qa", "audio", "render"].includes(stage)) {
    if (!(await storage.exists(paths.rev(rev).storyboard))) {
      throw new Error(`${projectId}: немає розкадровки ревізії ${rev} — перезапуск з «${stage}» неможливий`);
    }
  }
  if (
    (stage === "check" || stage === "qa" || stage === "render") &&
    !(await storage.exists(paths.rev(rev).scenesIndex))
  ) {
    throw new Error(`${projectId}: немає коду сцен ревізії ${rev} — перезапуск з «${stage}» неможливий`);
  }
  if (stage === "render" && !(await storage.exists(paths.rev(rev).audio))) {
    throw new Error(`${projectId}: немає audio.json ревізії ${rev} — перезапуск рендеру неможливий`);
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
      next.branches = { video: "running", audio: "done" };
      resetVideo();
      enqueue("codegen", { sceneIds: null, instructions: [] });
      break;
    case "check":
      next.status = "directing";
      next.branches = { video: "running", audio: "done" };
      resetVideo();
      enqueue("check", { sceneIds: null });
      break;
    case "qa":
      next.status = "directing";
      next.branches = { video: "running", audio: "done" };
      pipe.videoPhase = "build";
      pipe.qaRounds = 0;
      pipe.dirtyScenes = [];
      pipe.changedScenes = null;
      enqueue("qa", { sceneIds: null });
      break;
    case "audio":
      next.status = "directing";
      next.branches = { video: "done", audio: "running" };
      enqueue("audio", {});
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
    usdByStage: [...byStage.entries()]
      .map(([key, usd]) => ({ key, usd: round(usd) }))
      .sort((a, b) => b.usd - a.usd),
  };
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);
const sec = (v: number | null) => (v === null ? "—" : `${Math.round(v)} с`);

export function reportMarkdown(report: EvalReport): string {
  const s = report.summary;
  const lines = [
    `# Eval ${report.run}`,
    "",
    `Старт ${report.startedAt}, кінець ${report.finishedAt}.` +
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
  if (project.brandkitVersion !== null)
    await copy(projectPaths(projectId).brandkit(project.brandkitVersion), "brandkit.json");
  const stillsDir = path.join(storage.absPath(rev.root), "stills");
  if (existsSync(stillsDir)) {
    await cp(stillsDir, path.join(outDir, "stills"), { recursive: true });
    copied.push(`sites/${name}/stills/`);
  }
  return copied;
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
}

interface Target {
  name: string;
  projectId: string;
  formats: Format[] | null;
  language: "uk" | "en" | null;
  start: (h: Harness) => Promise<void>;
}

async function runTargets(
  harness: Harness,
  targets: readonly Target[],
  args: EvalArgs,
  runDir: string,
  print: (line: string) => void,
  now: () => Date,
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

  const startedAt = now();
  const run = runName(startedAt, args.runsDir, args.from ? `.from-${args.from}` : "");
  const runDir = path.join(args.runsDir, run);
  const dataDir = path.join(runDir, "data");
  await mkdir(dataDir, { recursive: true });
  if (baseDataDir) await cp(baseDataDir, dataDir, { recursive: true });
  print(`eval: прогін ${run} → ${runDir}`);

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
        projectId,
        formats: null,
        language: null,
        start: async (h) => {
          const jobs = await prepareRerun(h.storage, projectId, stage, now());
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
          });
        },
      });
    }
  }

  const reports = await runTargets(harness, targets, args, runDir, print, now);
  await harness.close();

  const report: EvalReport = {
    run,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
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
