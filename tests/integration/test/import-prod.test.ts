import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PipeState } from "@adc/pipeline";
import {
  type CostEvent,
  type FilmReview,
  LocalStorage,
  ProjectState,
  projectPaths,
  type QaReport,
  type ReviewIssue,
  sharedPaths,
} from "@adc/shared";
import { fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRerun } from "../src/eval.ts";
import { type BaseFile, IMPORT_USAGE, qaSeriousByRound, runImportCli } from "../src/import-prod.ts";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const AT = "2026-10-23T18:00:00.000Z";
const SCENES = fixtureStoryboard.scenes.map((s) => s.id); // s1, s2, s3

let tmp: string;
let from: string;
let runsDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "adc-import-"));
  from = path.join(tmp, "export");
  runsDir = path.join(tmp, "runs");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const code = (sceneId: string, v: number) => `export const ${sceneId} = "v${v}";\n`;

function version(v: number, origin: "codegen" | "fix", qaSerious: number | null, compileErrors = 0) {
  return {
    v,
    origin,
    createdAt: AT,
    codeHash: `h${v}`,
    missing: false,
    guardOk: true,
    violations: [],
    inputsHash: origin === "codegen" ? "in" : null,
    check: {
      compileErrors: Array.from({ length: compileErrors }, (_, i) => ({
        sceneId: "s",
        message: `TS2322 #${i}`,
        line: 1,
        column: 1,
      })),
      runtimeErrors: [],
      autoIssues: [],
      stills: [],
      checkedAt: AT,
    },
    qa: qaSerious === null ? null : { serious: qaSerious, issues: [] },
  };
}

/** Журнал v1–v3: s1 5 → 2 → 0; s2 4 → (v2 з двома TS-помилками, без QA) → 1; s3 3 → 1, без v3. */
const LEDGER = {
  scenes: {
    s1: { current: 3, versions: [version(1, "codegen", 5), version(2, "fix", 2), version(3, "fix", 0)] },
    s2: {
      current: 3,
      versions: [version(1, "codegen", 4), version(2, "fix", null, 2), version(3, "fix", 1)],
    },
    s3: { current: 2, versions: [version(1, "codegen", 3), version(2, "fix", 1)] },
  },
};

function cost(stage: CostEvent["stage"], usd: number, extra: Partial<CostEvent> = {}): CostEvent {
  return {
    ts: AT,
    projectId: "p1",
    rev: 1,
    stage,
    phase: "first_delivery",
    source: "chat",
    provider: "anthropic",
    model: "claude-opus-5-5",
    promptName: null,
    promptHash: null,
    effort: null,
    attempt: 1,
    units: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
    unitPrices: {},
    usd,
    exact: true,
    detail: null,
    ...extra,
  };
}

const tokens = (input: number, cacheRead: number, output: number) => ({
  input,
  output,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead,
});

const COSTS: CostEvent[] = [
  cost("brandkit", 0.5, { promptName: "brandkit", promptHash: "bk1" }),
  cost("storyboard", 0.5, { promptName: "storyboard", promptHash: "sb1" }),
  cost("audio", 0.25, { promptName: "audio-plan", promptHash: "ap1" }),
  cost("codegen", 0.25, { promptName: "codegen", promptHash: "cg1" }),
  cost("qa", 1, { promptName: "qa", promptHash: "qa1" }),
  cost("fix", 0.5, { promptName: "code-fix", promptHash: "cf1", detail: "warm" }),
  cost("fix", 1, {
    promptName: "code-fix",
    promptHash: "cf1",
    detail: "scene:s1",
    units: tokens(100, 1000, 50),
  }),
  cost("fix", 1.5, {
    promptName: "code-fix",
    promptHash: "cf2",
    detail: "scene:s2",
    units: tokens(200, 2000, 60),
  }),
  cost("sfx", 0.5, { promptName: "sfx-design", promptHash: "sd1" }),
  cost("review", 0.75, { promptName: "review", promptHash: "rv1" }),
  cost("render", 0.01, { provider: "remotion", model: "remotion", units: { renders: 1 } }),
];

function issue(over: Partial<ReviewIssue>): ReviewIssue {
  return {
    scope: "scene",
    sceneId: "s1",
    nextSceneId: null,
    eventId: null,
    frame: null,
    format: null,
    severity: "major",
    kind: "weak_moment",
    description: "d",
    fix: "f",
    fixSceneId: null,
    ...over,
  };
}

const REVIEW: FilmReview = {
  version: 1,
  round: 1,
  inputsHash: "rh",
  verdict: "fix",
  score: 7,
  summary: "s",
  joinSide: "both",
  routes: { fix: ["s1", "s2"], sfx: [], music: 0 },
  issues: [
    issue({ scope: "join", sceneId: "s1", nextSceneId: "s2", kind: "join_break" }),
    issue({ scope: "join", sceneId: "s2", nextSceneId: "s3", kind: "join_break", severity: "critical" }),
    issue({ severity: "minor", kind: "sfx_wrong_cue" }),
  ],
};

const QA: QaReport = {
  verdict: "fix",
  summary: "q",
  issues: [
    { sceneId: "s2", format: "vertical", severity: "major", kind: "weak_moment", description: "d", fix: "f" },
    { sceneId: "s3", format: "vertical", severity: "minor", kind: "weak_moment", description: "d", fix: "f" },
  ],
};

/** Що видаляє скидання (відносно `rev/1/`). */
const RESET_FILES = [
  "check.json",
  "qa.json",
  "review.json",
  "sfx-plan.json",
  "sound-sheet.json",
  "history/review-r0.json",
  "history/qa-a1.json",
  "stills/vertical/s1-a.png",
  "strips/vertical/s1.jpg",
  "moments/vertical/s1.jpg",
  "sheets/vertical.png",
  "renders/vertical.mp4",
  "renders/vertical.meta.json",
  "poster.png",
  "director/qa.meta.json",
  "director/check.meta.json",
];

/** Синтетична вигрузка зі структурою /data: проєкт p1 (v1–v3, рендер, check/qa/review, історія) і p2. */
async function writeExport(opts: { skipV1?: string[]; templateScenes?: string[] } = {}) {
  const s = new LocalStorage(from);
  for (const id of ["p1", "p2"]) {
    const pp = projectPaths(id);
    const rp = pp.rev(1);
    await s.writeJson(
      pp.project,
      fixtureProject({
        id,
        status: "delivered",
        brandkitVersion: 1,
        input: { kind: "site", url: `https://${id}.example.com/`, manualText: null },
        branches: { video: "done", audio: "done" },
        phase: "revision",
        firstDeliveredAt: AT,
        deliveredAt: AT,
      }),
    );
    await s.writeJson(pp.brandkit(1), { stub: true });
    await s.writeJson(pp.site, { stub: true });
    await s.write(
      pp.costs,
      `${COSTS.map((e) => JSON.stringify({ ...e, projectId: id })).join("\n")}\nбитий рядок\n`,
    );
    await s.write(pp.trace, "");
    await s.write(pp.music("ph"), "mp3");
    await s.writeJson(rp.storyboard, fixtureStoryboard);
    await s.writeJson(rp.audioPlan, { stub: true });
    await s.writeJson(rp.audio, { music: null, sfx: [], totalFrames: 450 });
    await s.writeJson(
      rp.pipeline,
      PipeState.parse({
        attempts: { codegen: 1, check: 3, qa: 2 },
        fixRounds: { s2: 1 },
        qaRounds: 2,
        reviewRounds: 1,
        templateScenes: opts.templateScenes ?? [],
        dirtyScenes: [],
      }),
    );
    await s.write(rp.scenesIndex, "export default {};\n");
    const dir = `${rp.root}/director`;
    await s.writeJson(`${dir}/scenes.json`, LEDGER);
    for (const [sceneId, entry] of Object.entries(LEDGER.scenes)) {
      for (const v of entry.versions) {
        if (v.v === 1 && opts.skipV1?.includes(sceneId)) continue;
        await s.write(`${dir}/versions/${sceneId}/v${v.v}.tsx`, code(sceneId, v.v));
        await s.write(`${dir}/versions/${sceneId}/v${v.v}/vertical-a.png`, "png");
      }
      await s.write(rp.scene(sceneId), code(sceneId, entry.current));
    }
    await s.writeJson(rp.check, { stub: true });
    await s.writeJson(rp.qa, QA);
    await s.writeJson(rp.review, REVIEW);
    for (const f of RESET_FILES.filter((f) => !["check.json", "qa.json", "review.json"].includes(f))) {
      await s.write(`${rp.root}/${f}`, "x");
    }
  }
  await s.write(sharedPaths.sfxCache("abc"), "mp3");
  await s.writeJson(sharedPaths.sfxCacheMeta("abc"), { cue: "whoosh" });
  await s.write("users/u1.json", "{}"); // не копіюється
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const exit = await runImportCli([...argv, "--out", runsDir], {
    print: (l) => lines.push(l),
    now: () => NOW,
    root: tmp,
  });
  return { code: exit, out: lines.join("\n") };
}

const EXPECTED_BASE = (fromDir: string, ids: string[]): BaseFile => ({
  importedAt: NOW.toISOString(),
  from: fromDir,
  reset: "codegen",
  sfxCacheFiles: 2,
  projects: Object.fromEntries(
    ids.map((id) => [
      id,
      {
        url: `https://${id}.example.com/`,
        formats: ["vertical"],
        rev: 1,
        promptHashes: {
          "audio-plan": ["ap1"],
          brandkit: ["bk1"],
          codegen: ["cg1"],
          "code-fix": ["cf1", "cf2"],
          qa: ["qa1"],
          review: ["rv1"],
          "sfx-design": ["sd1"],
          storyboard: ["sb1"],
        },
        review: {
          round: 1,
          score: 7,
          verdict: "fix",
          critical: 1,
          major: 1,
          minor: 1,
          joinBreaks: 2,
          routes: { fix: ["s1", "s2"], sfx: [], music: 0 },
        },
        qa: { verdict: "fix", serious: 1, minor: 1 },
        ledger: {
          qaSeriousByVersion: {
            s1: [
              { v: 1, origin: "codegen", serious: 5 },
              { v: 2, origin: "fix", serious: 2 },
              { v: 3, origin: "fix", serious: 0 },
            ],
            s2: [
              { v: 1, origin: "codegen", serious: 4 },
              { v: 3, origin: "fix", serious: 1 },
            ],
            s3: [
              { v: 1, origin: "codegen", serious: 3 },
              { v: 2, origin: "fix", serious: 1 },
            ],
          },
          // коло 3: s1 → 0, s2 і s3 несуть останнє значення (1 і 1)
          qaSeriousByRound: [12, 4, 2],
          fixCompileErrors: [{ sceneId: "s2", v: 2, errors: 2 }],
          fixVersions: 5,
        },
        fix: { calls: 2, warm: 1, input: 300, cacheRead: 3000, output: 110, usd: 2.5 },
        usd: {
          total: 6.76,
          byStage: {
            fix: 3,
            qa: 1,
            review: 0.75,
            brandkit: 0.5,
            storyboard: 0.5,
            sfx: 0.5,
            audio: 0.25,
            codegen: 0.25,
            render: 0.01,
          },
          // qa 1 + fix 3 + sfx 0.5 + review 0.75 + render 0.01
          fromCheck: 5.26,
        },
        renders: ["vertical.mp4"],
      },
    ]),
  ),
});

describe("eval-import", () => {
  it("--help — довідка, код 0", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(IMPORT_USAGE);
  });

  it("--reset codegen: журнал лише v1, сцени = код v1, результати стадій видалено; base.json і рендери бази", async () => {
    await writeExport();
    const r = await run(["--from", from, "--run", "lx-base", "--reset", "codegen"]);
    expect(r.out).toContain("готово");
    expect(r.code).toBe(0);
    const runDir = path.join(runsDir, "lx-base");
    const data = new LocalStorage(path.join(runDir, "data"));

    for (const id of ["p1", "p2"]) {
      const rp = projectPaths(id).rev(1);
      const ledger = JSON.parse(await data.readText(`${rp.root}/director/scenes.json`));
      for (const sceneId of SCENES) {
        expect(ledger.scenes[sceneId].current).toBe(1);
        expect(ledger.scenes[sceneId].versions.map((v: { v: number }) => v.v)).toEqual([1]);
        // решта полів версії збережена як є
        expect(ledger.scenes[sceneId].versions[0]).toEqual(LEDGER.scenes[sceneId as "s1"].versions[0]);
        expect(await data.readText(rp.scene(sceneId))).toBe(code(sceneId, 1));
        const files = await readdir(data.absPath(`${rp.root}/director/versions/${sceneId}`));
        expect(files.sort()).toEqual(["v1", "v1.tsx"]);
      }
      for (const f of RESET_FILES) expect(await data.exists(`${rp.root}/${f}`), f).toBe(false);
      for (const dir of ["history", "stills", "strips", "moments", "sheets", "renders"]) {
        expect(existsSync(data.absPath(`${rp.root}/${dir}`)), dir).toBe(false);
      }
      // лишається: розкадровка, план і трек, бренд-кіт, краул, index.ts сцен, витрати й трейс
      for (const key of [
        rp.storyboard,
        rp.audioPlan,
        rp.audio,
        rp.scenesIndex,
        rp.pipeline,
        projectPaths(id).brandkit(1),
        projectPaths(id).site,
        projectPaths(id).music("ph"),
        projectPaths(id).costs,
        projectPaths(id).trace,
      ]) {
        expect(await data.exists(key), key).toBe(true);
      }
    }
    // кеш SFX скопійовано, users/ — ні
    expect(await data.readText(sharedPaths.sfxCache("abc"))).toBe("mp3");
    expect(await data.exists(sharedPaths.sfxCacheMeta("abc"))).toBe(true);
    expect(await data.exists("users/u1.json")).toBe(false);

    const base = JSON.parse(await readFile(path.join(runDir, "base.json"), "utf8"));
    expect(base).toEqual(EXPECTED_BASE(from, ["p1", "p2"]));
    expect(await readFile(path.join(runDir, "base", "p1", "vertical.mp4"), "utf8")).toBe("x");

    // вигрузку лише прочитано
    const src = new LocalStorage(from);
    expect(await src.readText(projectPaths("p1").rev(1).scene("s1"))).toBe(code("s1", 3));
    expect(await src.exists(projectPaths("p1").rev(1).review)).toBe(true);
    // тимчасової теки не лишилось
    expect(await readdir(runsDir)).toEqual(["lx-base"]);
  });

  it("prepareRerun(check) на імпортованих даних повертає job check без помилок", async () => {
    await writeExport();
    expect((await run(["--from", from, "--run", "base", "--reset", "codegen"])).code).toBe(0);
    const data = new LocalStorage(path.join(runsDir, "base", "data"));
    const jobs = await prepareRerun(data, "p1", "check", NOW, "designer", {
      music: "elevenlabs",
      sfx: "elevenlabs",
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ stage: "check", projectId: "p1", rev: 1, params: { sceneIds: null } });
    const project = await data.readJson(projectPaths("p1").project, (v) => ProjectState.parse(v));
    expect(project.status).toBe("directing");
  });

  it("--project копіює лише вказані проєкти", async () => {
    await writeExport();
    const r = await run(["--from", from, "--run", "one", "--reset", "codegen", "--project", "p2"]);
    expect(r.code).toBe(0);
    const runDir = path.join(runsDir, "one");
    expect(await readdir(path.join(runDir, "data", "projects"))).toEqual(["p2"]);
    expect(await readdir(path.join(runDir, "base"))).toEqual(["p2"]);
    const base = JSON.parse(await readFile(path.join(runDir, "base.json"), "utf8"));
    expect(base).toEqual(EXPECTED_BASE(from, ["p2"]));
    expect(existsSync(path.join(runDir, "data", sharedPaths.sfxCache("abc")))).toBe(true);
  });

  it("без --reset дані копіюються як у вигрузці", async () => {
    await writeExport();
    expect((await run(["--from", from, "--run", "raw"])).code).toBe(0);
    const data = new LocalStorage(path.join(runsDir, "raw", "data"));
    expect(await data.readText(projectPaths("p1").rev(1).scene("s1"))).toBe(code("s1", 3));
    expect(await data.exists(projectPaths("p1").rev(1).review)).toBe(true);
    const base = JSON.parse(await readFile(path.join(runsDir, "raw", "base.json"), "utf8"));
    expect(base.reset).toBeNull();
  });

  it("немає v1.tsx → код 2 з переліком сцен, тека прогону не створюється", async () => {
    await writeExport({ skipV1: ["s1", "s3"] });
    const r = await run(["--from", from, "--run", "bad", "--reset", "codegen"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("v1.tsx для сцен: s1, s3");
    expect(existsSync(path.join(runsDir, "bad"))).toBe(false);
    expect(existsSync(runsDir) ? await readdir(runsDir) : []).toEqual([]);
  });

  it("шаблонні сцени і версія 1 не з codegen → код 2", async () => {
    await writeExport({ templateScenes: ["s2"] });
    const s = new LocalStorage(from);
    const key = `${projectPaths("p1").rev(1).root}/director/scenes.json`;
    const ledger = structuredClone(LEDGER);
    (ledger.scenes.s3.versions[0] as { origin: string }).origin = "carry";
    await s.writeJson(key, ledger);
    const r = await run(["--from", from, "--run", "bad", "--project", "p1"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("шаблонні сцени (templateScenes): s2");
    expect(r.out).toContain('не origin "codegen" для сцен: s3 (carry)');
    expect(existsSync(path.join(runsDir, "bad"))).toBe(false);
  });

  it("стан проєкту не розбирається → код 2", async () => {
    await writeExport();
    await writeFile(path.join(from, "projects", "p1", "project.json"), JSON.stringify({ id: "p1" }));
    const r = await run(["--from", from, "--run", "bad", "--project", "p1"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("project.json не розбирається поточним кодом");
  });

  it("тека прогону вже існує → код 2, її вміст не чіпається", async () => {
    await writeExport();
    await mkdir(path.join(runsDir, "taken"), { recursive: true });
    await writeFile(path.join(runsDir, "taken", "keep.txt"), "k");
    const r = await run(["--from", from, "--run", "taken", "--reset", "codegen"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("тека прогону вже існує");
    expect(await readdir(path.join(runsDir, "taken"))).toEqual(["keep.txt"]);
  });

  it("невідомий проєкт і погані аргументи → код 2", async () => {
    await writeExport();
    expect((await run(["--from", from, "--run", "x", "--project", "nope"])).out).toContain(
      "немає у вигрузці: nope",
    );
    expect((await run(["--from", from, "--run", "x", "--reset", "qa"])).code).toBe(2);
    expect((await run(["--from", from, "--run", "../x"])).code).toBe(2);
    expect((await run(["--run", "x"])).code).toBe(2);
    expect(existsSync(path.join(runsDir, "x"))).toBe(false);
  });

  it("qaSeriousByRound: сцени з меншою кількістю кіл несуть останнє значення", () => {
    expect(qaSeriousByRound({})).toEqual([]);
    expect(
      qaSeriousByRound({
        a: [{ v: 1, origin: "codegen", serious: 3 }],
        b: [
          { v: 1, origin: "codegen", serious: 2 },
          { v: 2, origin: "fix", serious: 0 },
        ],
      }),
    ).toEqual([5, 3]);
  });
});
