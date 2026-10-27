import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PipeState } from "@adc/pipeline";
import {
  countSerious,
  FilmReview,
  findRepoRoot,
  groupUsd,
  LocalStorage,
  PROJECTS_DIR,
  type ProjectState,
  ProjectState as ProjectStateSchema,
  projectPaths,
  QaReport,
  readCosts,
  type Storage,
  Storyboard,
  sharedPaths,
  sumUsd,
} from "@adc/shared";
import { z } from "zod";

/**
 * Імпорт прод-проєкту як бази для `pnpm eval --from check|review|sfx` (ТЗ класу A, Блок 8; порядок перевірки —
 * `docs/analysis/cost-optimization.md` §5). CLI — `scripts/eval-import.ts`.
 *
 * Вигрузка — тека зі структурою `/data` прода: `projects/<id>/…` і `cache/sfx/…`. Імпорт:
 * 1. перевіряє кожен проєкт (стан, `pipeline.json`, розкадровка ревізії, `v1.tsx` codegen кожної сцени, без
 *    шаблонних сцен) — будь-яка проблема → код 2, тека прогону не створюється;
 * 2. пише метрики бази ДО скидання в `eval/runs/<run>/base.json`, рендери бази — у `base/<id>/`;
 * 3. копіює проєкти й кеш SFX у `eval/runs/<run>/data/` і з `--reset codegen` скидає копію до коду codegen (v1).
 *
 * Вигрузку лише читає. Без мережі й API. Пише в тимчасову теку поруч і перейменовує її в `<run>` наприкінці.
 */

export const IMPORT_USAGE = `Використання:
  pnpm tsx scripts/eval-import.ts --from <вигрузка> --run <ім'я> [--reset codegen] [--project <id>]…

Імпорт прод-проєктів як бази для \`pnpm eval -- --from check|review|sfx --run <ім'я>\`
(покрокова перевірка: docs/analysis/cost-optimization.md §5). Без мережі й API, вигрузку лише читає.

  --from <тека>        вигрузка зі структурою /data: projects/<id>/… і cache/sfx/…
  --run <ім'я>         тека прогону eval/runs/<ім'я>/ (не повинна існувати)
  --reset codegen      скинути копію до коду codegen: сцени = v1, версії > 1 і результати
                       check/qa/review/sfx/render видалено (без цього — дані як у вигрузці)
  --project <id>       імпортувати лише цей проєкт (можна кілька разів; дефолт — усі)
  --out <тека>         де лежать прогони (дефолт eval/runs)
  -h, --help           ця довідка

Результат eval/runs/<ім'я>/:
  data/projects/<id>/  копія проєкту (з --reset codegen — скинута до v1)
  data/cache/sfx/      кеш SFX (без нього зведення заново згенерує стандартні SFX)
  base.json            метрики бази до скидання: рецензія, QA, журнал версій, $ за стадіями
  base/<id>/*.mp4      рендери бази

Помилка (немає v1.tsx, шаблонні сцени, тека прогону вже є тощо) → код 2, тека прогону не створюється.`;

export interface ImportArgs {
  from: string;
  run: string;
  reset: "codegen" | null;
  /** Порожньо — усі проєкти вигрузки. */
  projects: string[];
  runsDir: string;
  help: boolean;
}

/** Помилка імпорту, яку бачить користувач (код 2). */
export class ImportError extends Error {}

export function parseImportArgs(argv: readonly string[], root: string = findRepoRoot()): ImportArgs {
  const args: ImportArgs = {
    from: "",
    run: "",
    reset: null,
    projects: [],
    runsDir: path.join(root, "eval", "runs"),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const get = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new ImportError(`${flag}: потрібне значення`);
      return v;
    };
    switch (flag) {
      case "--":
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--from":
        args.from = path.resolve(get());
        break;
      case "--run":
        args.run = get();
        break;
      case "--reset": {
        const v = get();
        if (v !== "codegen") throw new ImportError(`--reset: невідомий режим "${v}" (лише codegen)`);
        args.reset = v;
        break;
      }
      case "--project":
        args.projects.push(get());
        break;
      case "--out":
        args.runsDir = path.resolve(get());
        break;
      default:
        throw new ImportError(`невідомий аргумент "${flag}"`);
    }
  }
  if (args.help) return args;
  if (!args.from) throw new ImportError("потрібен --from <вигрузка>");
  if (!args.run) throw new ImportError("потрібен --run <ім'я>");
  if (!/^[\w][\w.-]*$/.test(args.run)) {
    throw new ImportError(`--run: ім'я "${args.run}" — лише літери, цифри, «.», «-», «_», без шляхів`);
  }
  return args;
}

// ───────────────────────────── журнал версій ─────────────────────────────

/**
 * Журнал версій `rev/<n>/director/scenes.json` у форматі `packages/director/src/ledger.ts` (поля `current`,
 * `versions[].v`, `origin`, `qa.serious`, `check.compileErrors`). Пакет режисера сюди не імпортується — лише
 * потрібні поля, решта зберігається як є (скидання записує журнал назад без втрат).
 */
const LedgerVersion = z.looseObject({
  v: z.number().int().min(1),
  origin: z.string(),
  check: z
    .looseObject({ compileErrors: z.array(z.unknown()) })
    .nullable()
    .optional(),
  qa: z.looseObject({ serious: z.number().int() }).nullable().optional(),
});
type LedgerVersion = z.infer<typeof LedgerVersion>;

const Ledger = z.looseObject({
  scenes: z.record(
    z.string(),
    z.looseObject({ current: z.number().int().min(1), versions: z.array(LedgerVersion) }),
  ),
});
type Ledger = z.infer<typeof Ledger>;

const join = (...parts: Array<string | number>): string => parts.map(String).join("/");

/** Шляхи режисера (як `directorPaths` у `packages/director/src/io.ts`). */
function directorKeys(projectId: string, rev: number) {
  const root = join(projectPaths(projectId).rev(rev).root, "director");
  return {
    root,
    ledger: join(root, "scenes.json"),
    versionsDir: (sceneId: string) => join(root, "versions", sceneId),
    version: (sceneId: string, v: number) => join(root, "versions", sceneId, `v${v}.tsx`),
    qaMeta: join(root, "qa.meta.json"),
    checkMeta: join(root, "check.meta.json"),
  };
}

// ───────────────────────────── перевірка ─────────────────────────────

/** Розібраний проєкт вигрузки (після перевірки). */
export interface ImportedProject {
  project: ProjectState;
  storyboard: Storyboard;
  ledger: Ledger;
}

const zodMessage = (err: unknown): string =>
  err instanceof z.ZodError
    ? err.issues.map((i) => `${i.path.join(".") || "(корінь)"}: ${i.message}`).join("; ")
    : (err as Error).message;

/** Розбирає JSON сховища; немає файлу або не за схемою — рядок проблеми в `problems`, результат null. */
async function readChecked<T>(
  storage: Storage,
  key: string,
  parse: (v: unknown) => T,
  problems: string[],
): Promise<T | null> {
  if (!(await storage.exists(key))) {
    problems.push(`немає ${key}`);
    return null;
  }
  try {
    return await storage.readJson(key, parse);
  } catch (err) {
    problems.push(`${key} не розбирається поточним кодом: ${zodMessage(err)}`);
    return null;
  }
}

/**
 * Перевіряє проєкт вигрузки. Повертає перелік проблем (порожній — придатний як база) і розібрані дані.
 * Крім вимог ТЗ перевіряє `video/scenes/index.ts` і бренд-кіт: без них `prepareRerun("check")` впаде вже під
 * час платного прогону.
 */
export async function validateProject(
  storage: Storage,
  projectId: string,
): Promise<{ problems: string[]; data: ImportedProject | null }> {
  const problems: string[] = [];
  const paths = projectPaths(projectId);
  const project = await readChecked(storage, paths.project, (v) => ProjectStateSchema.parse(v), problems);
  if (!project) return { problems, data: null };
  const rev = project.rev;
  const rp = paths.rev(rev);
  const dk = directorKeys(projectId, rev);

  if (project.brandkitVersion === null) problems.push("немає бренд-кіта (project.brandkitVersion = null)");
  const pipe = await readChecked(storage, rp.pipeline, (v) => PipeState.parse(v), problems);
  if (pipe && pipe.templateScenes.length > 0) {
    problems.push(
      `шаблонні сцени (templateScenes): ${pipe.templateScenes.join(", ")} — з ними база непорівнянна`,
    );
  }
  const storyboard = await readChecked(storage, rp.storyboard, (v) => Storyboard.parse(v), problems);
  if (!(await storage.exists(rp.scenesIndex))) problems.push(`немає ${rp.scenesIndex}`);
  const ledger = await readChecked(storage, dk.ledger, (v) => Ledger.parse(v), problems);

  if (storyboard) {
    const noCode: string[] = [];
    const notCodegen: string[] = [];
    for (const { id } of storyboard.scenes) {
      if (!(await storage.exists(dk.version(id, 1)))) noCode.push(id);
      if (ledger) {
        const v1 = ledger.scenes[id]?.versions.find((v) => v.v === 1);
        if (v1?.origin !== "codegen") notCodegen.push(`${id} (${v1 ? v1.origin : "немає в журналі"})`);
      }
    }
    if (noCode.length > 0) {
      problems.push(`немає ${dk.root}/versions/<sN>/v1.tsx для сцен: ${noCode.join(", ")}`);
    }
    if (notCodegen.length > 0) {
      problems.push(`версія 1 у журналі не origin "codegen" для сцен: ${notCodegen.join(", ")}`);
    }
  }
  return {
    problems,
    data: problems.length === 0 && storyboard && ledger ? { project, storyboard, ledger } : null,
  };
}

// ───────────────────────────── метрики бази ─────────────────────────────

/** Стадії до check: не перезапускаються в `eval --from check`, тож не входять у `usd.fromCheck`. */
export const PRE_CHECK_STAGES: ReadonlySet<string> = new Set(["brandkit", "storyboard", "codegen", "audio"]);

export interface BaseReview {
  round: number;
  score: number;
  verdict: "pass" | "fix";
  critical: number;
  major: number;
  minor: number;
  joinBreaks: number;
  routes: FilmReview["routes"];
}

export interface BaseProject {
  url: string | null;
  formats: ProjectState["formats"];
  rev: number;
  /** promptName → хеші промптів з `costs.jsonl` (кілька — промпт змінювався між викликами). */
  promptHashes: Record<string, string[]>;
  /** Фінальна рецензія (`review.json`); немає — null. */
  review: BaseReview | null;
  /** Фінальний `qa.json`: serious — major + critical. */
  qa: { verdict: "pass" | "fix"; serious: number; minor: number } | null;
  ledger: {
    /** Серйозні QA по версіях сцени (лише версії, які бачив QA). */
    qaSeriousByVersion: Record<string, Array<{ v: number; origin: string; serious: number }>>;
    /**
     * Оцінка серйозних QA по колах: k-те коло — сума по сценах k-ї версії з QA (сцена, яку коло не
     * чіпало, лишається з останнім значенням). Для бази lx — 27 → 13 → 2.
     */
    qaSeriousByRound: number[];
    /** Версії `origin: "fix"` з помилками компіляції (TS-помилки, внесені fix). */
    fixCompileErrors: Array<{ sceneId: string; v: number; errors: number }>;
    /** Кількість версій `origin: "fix"` — викликів fix, що дали версію. */
    fixVersions: number;
  };
  /** Виклики fix з `costs.jsonl`: `scene:*` (разом із `:file-fallback`), прогріви `warm`. */
  fix: { calls: number; warm: number; input: number; cacheRead: number; output: number; usd: number };
  usd: {
    total: number;
    byStage: Record<string, number>;
    /** Відрізок від check: усе, крім brandkit, storyboard, codegen і audio. */
    fromCheck: number;
  };
  /** Рендери бази, скопійовані в `base/<id>/`. */
  renders: string[];
}

export interface BaseFile {
  importedAt: string;
  from: string;
  reset: ImportArgs["reset"];
  /** Файлів у `data/cache/sfx/`. */
  sfxCacheFiles: number;
  projects: Record<string, BaseProject>;
}

/** k-те коло — сума k-ї версії з QA по сценах; сцени з меншою кількістю кіл несуть останнє значення. */
export function qaSeriousByRound(byVersion: BaseProject["ledger"]["qaSeriousByVersion"]): number[] {
  const lists = Object.values(byVersion).filter((l) => l.length > 0);
  const rounds = Math.max(0, ...lists.map((l) => l.length));
  return Array.from({ length: rounds }, (_, k) =>
    lists.reduce((acc, l) => acc + (l[Math.min(k, l.length - 1)] as { serious: number }).serious, 0),
  );
}

const isTokens = (u: unknown): u is { input: number; output: number; cacheRead: number } =>
  typeof u === "object" && u !== null && "input" in u && "cacheRead" in u;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Метрики бази з вигрузки (до скидання). */
export async function baseMetrics(
  storage: Storage,
  projectId: string,
  data: ImportedProject,
): Promise<Omit<BaseProject, "renders">> {
  const { project, ledger } = data;
  const rp = projectPaths(projectId).rev(project.rev);

  const costs = await readCosts(storage, projectId);
  const hashes = new Map<string, Set<string>>();
  for (const e of costs) {
    if (e.promptName === null || e.promptHash === null) continue;
    const set = hashes.get(e.promptName) ?? new Set();
    set.add(e.promptHash);
    hashes.set(e.promptName, set);
  }
  const fixScene = costs.filter((e) => e.stage === "fix" && (e.detail ?? "").startsWith("scene:"));
  const tokens = (k: "input" | "cacheRead" | "output") =>
    fixScene.reduce((acc, e) => acc + (isTokens(e.units) ? e.units[k] : 0), 0);

  let review: BaseReview | null = null;
  if (await storage.exists(rp.review)) {
    const r = await storage.readJson(rp.review, (v) => FilmReview.parse(v));
    const sev = (s: string) => r.issues.filter((i) => i.severity === s).length;
    review = {
      round: r.round,
      score: r.score,
      verdict: r.verdict,
      critical: sev("critical"),
      major: sev("major"),
      minor: sev("minor"),
      joinBreaks: r.issues.filter((i) => i.kind === "join_break").length,
      routes: r.routes,
    };
  }
  let qa: BaseProject["qa"] = null;
  if (await storage.exists(rp.qa)) {
    const q = await storage.readJson(rp.qa, (v) => QaReport.parse(v));
    qa = {
      verdict: q.verdict,
      serious: countSerious(q.issues),
      minor: q.issues.filter((i) => i.severity === "minor").length,
    };
  }

  const byVersion: BaseProject["ledger"]["qaSeriousByVersion"] = {};
  const fixCompileErrors: BaseProject["ledger"]["fixCompileErrors"] = [];
  let fixVersions = 0;
  for (const [sceneId, entry] of Object.entries(ledger.scenes)) {
    const versions = [...entry.versions].sort((a, b) => a.v - b.v);
    byVersion[sceneId] = versions
      .filter((v): v is LedgerVersion & { qa: { serious: number } } => v.qa != null)
      .map((v) => ({ v: v.v, origin: v.origin, serious: v.qa.serious }));
    for (const v of versions) {
      if (v.origin !== "fix") continue;
      fixVersions += 1;
      const errors = v.check?.compileErrors.length ?? 0;
      if (errors > 0) fixCompileErrors.push({ sceneId, v: v.v, errors });
    }
  }

  return {
    url: project.input.url,
    formats: project.formats,
    rev: project.rev,
    promptHashes: Object.fromEntries(
      [...hashes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, [...s].sort()]),
    ),
    review,
    qa,
    ledger: {
      qaSeriousByVersion: byVersion,
      qaSeriousByRound: qaSeriousByRound(byVersion),
      fixCompileErrors,
      fixVersions,
    },
    fix: {
      calls: fixScene.length,
      warm: costs.filter((e) => e.stage === "fix" && e.detail === "warm").length,
      input: tokens("input"),
      cacheRead: tokens("cacheRead"),
      output: tokens("output"),
      usd: sumUsd(fixScene),
    },
    usd: {
      total: sumUsd(costs),
      byStage: Object.fromEntries(groupUsd(costs, (e) => e.stage).map((g) => [g.key, g.usd])),
      fromCheck: round6(sumUsd(costs, (e) => !PRE_CHECK_STAGES.has(e.stage))),
    },
  };
}

// ───────────────────────────── скидання до codegen ─────────────────────────────

/** Що видаляє `--reset codegen` у `rev/<n>/` (результати стадій від check і далі). */
export const RESET_REV_ENTRIES = [
  "check.json",
  "qa.json",
  "review.json",
  "sfx-plan.json",
  "sound-sheet.json",
  "history",
  "stills",
  "strips",
  "moments",
  "sheets",
  "renders",
  "poster.png",
  "director/qa.meta.json",
  "director/check.meta.json",
] as const;

/**
 * Скидає проєкт сховища (копії!) до коду codegen: `video/scenes/<sN>.tsx` ← v1, у журналі лише v1 з
 * `current = 1`, файли версій > 1 і результати check/qa/review/sfx/render видалено. Решта (розкадровка, план
 * і трек, бренд-кіт, краул, `index.ts` сцен, `costs.jsonl`, `trace.jsonl`) лишається.
 */
export async function resetToCodegen(storage: Storage, projectId: string): Promise<void> {
  const project = await storage.readJson(projectPaths(projectId).project, (v) => ProjectStateSchema.parse(v));
  const rp = projectPaths(projectId).rev(project.rev);
  const dk = directorKeys(projectId, project.rev);
  const ledger = await storage.readJson(dk.ledger, (v) => Ledger.parse(v));

  for (const [sceneId, entry] of Object.entries(ledger.scenes)) {
    entry.versions = entry.versions.filter((v) => v.v === 1);
    entry.current = 1;
    if (await storage.exists(dk.version(sceneId, 1)))
      await storage.copy(dk.version(sceneId, 1), rp.scene(sceneId));
    // Лишаються лише `v1.tsx` і стіли `v1/`.
    const dir = storage.absPath(dk.versionsDir(sceneId));
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) {
      if (name === "v1.tsx" || name === "v1") continue;
      await rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
  await storage.writeJson(dk.ledger, ledger);
  for (const entry of RESET_REV_ENTRIES) {
    await rm(storage.absPath(join(rp.root, entry)), { recursive: true, force: true });
  }
}

// ───────────────────────────── імпорт ─────────────────────────────

async function countFiles(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).length;
}

/** Проєкти вигрузки: усі теки `projects/` або перелік `--project` (кожен має бути у вигрузці). */
async function selectProjects(from: string, wanted: readonly string[]): Promise<string[]> {
  const dir = path.join(from, PROJECTS_DIR);
  if (!existsSync(dir)) throw new ImportError(`у вигрузці немає теки ${PROJECTS_DIR}/ (${dir})`);
  const all = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (wanted.length === 0) {
    if (all.length === 0) throw new ImportError(`у ${dir} немає проєктів`);
    return all;
  }
  const missing = wanted.filter((id) => !all.includes(id));
  if (missing.length > 0) {
    throw new ImportError(`немає у вигрузці: ${missing.join(", ")} (є: ${all.join(", ") || "—"})`);
  }
  return [...new Set(wanted)];
}

export interface ImportResult {
  runDir: string;
  base: BaseFile;
}

/** Імпорт за розібраними аргументами. Помилки користувача — `ImportError`; тека прогону тоді не лишається. */
export async function importProd(
  args: ImportArgs,
  print: (line: string) => void,
  now: Date = new Date(),
): Promise<ImportResult> {
  const runDir = path.join(args.runsDir, args.run);
  if (existsSync(runDir)) throw new ImportError(`тека прогону вже існує: ${runDir}`);
  if (!existsSync(args.from)) throw new ImportError(`немає вигрузки: ${args.from}`);
  const ids = await selectProjects(args.from, args.projects);

  // Перевірка й метрики — по вигрузці (лише читання), до будь-якого запису.
  const source = new LocalStorage(args.from);
  const checked = new Map<string, ImportedProject>();
  const failures: string[] = [];
  for (const id of ids) {
    const { problems, data } = await validateProject(source, id);
    if (data) checked.set(id, data);
    else failures.push(`${id}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  if (failures.length > 0) {
    throw new ImportError(`вигрузка непридатна як база:\n${failures.join("\n")}`);
  }

  const sfxSource = path.join(args.from, ...sharedPaths.sfxCacheDir.split("/"));
  if (!existsSync(sfxSource)) {
    print(
      `eval-import: УВАГА — у вигрузці немає ${sharedPaths.sfxCacheDir}/: зведення заново згенерує стандартні SFX ` +
        "(+≈ $0.47 за прогін, інші семпли)",
    );
  }

  // Усе пишемо в тимчасову теку поруч і перейменовуємо наприкінці: помилка не лишає півготового прогону.
  const staging = path.join(args.runsDir, `.${args.run}.importing`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const dataDir = path.join(staging, "data");
    const projects: Record<string, BaseProject> = {};
    for (const id of ids) {
      const data = checked.get(id) as ImportedProject;
      const metrics = await baseMetrics(source, id, data);
      const rendersSrc = path.join(source.absPath(projectPaths(id).rev(data.project.rev).root), "renders");
      const renders = existsSync(rendersSrc)
        ? (await readdir(rendersSrc)).filter((f) => f.endsWith(".mp4")).sort()
        : [];
      if (renders.length > 0) await mkdir(path.join(staging, "base", id), { recursive: true });
      for (const f of renders) await cp(path.join(rendersSrc, f), path.join(staging, "base", id, f));
      if (renders.length === 0)
        print(`eval-import: УВАГА — ${id}: немає рендерів бази (rev/<n>/renders/*.mp4)`);
      projects[id] = { ...metrics, renders };

      await cp(source.absPath(projectPaths(id).root), path.join(dataDir, PROJECTS_DIR, id), {
        recursive: true,
      });
    }
    const sfxTarget = path.join(dataDir, ...sharedPaths.sfxCacheDir.split("/"));
    if (existsSync(sfxSource)) await cp(sfxSource, sfxTarget, { recursive: true });

    if (args.reset === "codegen") {
      const copy = new LocalStorage(dataDir);
      for (const id of ids) await resetToCodegen(copy, id);
    }

    const base: BaseFile = {
      importedAt: now.toISOString(),
      from: args.from,
      reset: args.reset,
      sfxCacheFiles: await countFiles(sfxTarget),
      projects,
    };
    await writeFile(path.join(staging, "base.json"), `${JSON.stringify(base, null, 2)}\n`, "utf8");
    await rename(staging, runDir);
    return { runDir, base };
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

export interface ImportDeps {
  print?: (line: string) => void;
  now?: () => Date;
  /** Корінь репозиторію (дефолт eval/runs рахується від нього). */
  root?: string;
}

/** CLI `scripts/eval-import.ts`: 0 — готово, 2 — помилка (повідомлення надруковано). */
export async function runImportCli(argv: readonly string[], deps: ImportDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  let args: ImportArgs;
  try {
    args = parseImportArgs(argv, deps.root ?? findRepoRoot());
  } catch (err) {
    print(`eval-import: ${(err as Error).message}\n\n${IMPORT_USAGE}`);
    return 2;
  }
  if (args.help) {
    print(IMPORT_USAGE);
    return 0;
  }
  try {
    const { runDir, base } = await importProd(args, print, (deps.now ?? (() => new Date()))());
    for (const [id, p] of Object.entries(base.projects)) {
      const review = p.review ? `рецензія ${p.review.score}/10, major ${p.review.major}` : "рецензії немає";
      print(
        `eval-import: ${id} (${p.url ?? "—"}): ${review}; QA по колах ${p.ledger.qaSeriousByRound.join(" → ") || "—"}; ` +
          `$ ${p.usd.total.toFixed(2)} (від check ${p.usd.fromCheck.toFixed(2)}); рендерів ${p.renders.length}`,
      );
    }
    print(
      `eval-import: готово → ${runDir} (${args.reset ? "скинуто до codegen" : "без скидання"}, ` +
        `кеш SFX: ${base.sfxCacheFiles} файлів). Далі: pnpm eval -- --from check --run ${args.run}`,
    );
    return 0;
  } catch (err) {
    print(`eval-import: ${(err as Error).message}`);
    return 2;
  }
}
