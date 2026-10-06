import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PipeState } from "@adc/pipeline";
import { LocalStorage, ProjectState, projectPaths } from "@adc/shared";
import { fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EvalReport,
  loadSites,
  parseEvalArgs,
  prepareRerun,
  reportMarkdown,
  runEvalCli,
  runName,
  type SiteReport,
  slugify,
  summarize,
} from "../src/eval.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "adc-eval-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("pnpm eval — порожній список", () => {
  it("завершується повідомленням «список порожній» без помилки й без ключів API", async () => {
    const sites = path.join(tmp, "sites.json");
    await writeFile(sites, "[]\n");
    const lines: string[] = [];
    const saved = { a: process.env.ANTHROPIC_API_KEY, e: process.env.ELEVENLABS_API_KEY };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const code = await runEvalCli(["--sites", sites, "--out", path.join(tmp, "runs")], {
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("список порожній");
    } finally {
      if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.e !== undefined) process.env.ELEVENLABS_API_KEY = saved.e;
    }
  });

  it("відсутній файл — теж порожній список", async () => {
    expect(await loadSites(path.join(tmp, "nope.json"))).toEqual([]);
  });

  it("репозиторний eval/sites.json валідний", async () => {
    const args = parseEvalArgs([]);
    await expect(loadSites(args.sites)).resolves.toBeInstanceOf(Array);
  });
});

describe("loadSites", () => {
  it("приймає рядки й об'єкти; формати в будь-якому записі; фото відносно файлу", async () => {
    const file = path.join(tmp, "sites.json");
    await writeFile(
      file,
      JSON.stringify([
        "https://www.coffee.example.com/",
        {
          url: "https://dent.example.com/en/",
          name: "Dental EN",
          formats: ["16:9", "vertical"],
          language: "en",
          photos: ["p/1.jpg"],
        },
        { text: "Шиномонтаж на Сихові, працюємо з 8:00" },
      ]),
    );
    const sites = await loadSites(file);
    expect(sites[0]).toMatchObject({
      name: "coffee-example-com",
      url: "https://www.coffee.example.com/",
      formats: ["vertical"],
    });
    expect(sites[1]).toMatchObject({ name: "Dental EN", formats: ["vertical", "landscape"], language: "en" });
    expect(sites[1]?.photos).toEqual([path.join(tmp, "p", "1.jpg")]);
    expect(sites[2]).toMatchObject({
      url: null,
      text: "Шиномонтаж на Сихові, працюємо з 8:00",
      name: "manual-3",
    });
  });

  it("невідомий формат або сайт без url і text — зрозуміла помилка", async () => {
    const file = path.join(tmp, "sites.json");
    await writeFile(file, JSON.stringify([{ url: "https://a.example.com", formats: ["4:5"] }]));
    await expect(loadSites(file)).rejects.toThrow(/4:5/);
    await writeFile(file, JSON.stringify([{ name: "x" }]));
    await expect(loadSites(file)).rejects.toThrow(/без url і text/);
  });

  it("slugify дає безпечне ім'я теки", () => {
    expect(slugify("https://www.Кава-Львів.example.com/uk/?a=1")).toBe("кава-львів-example-com-uk-a-1");
    expect(slugify("///")).toBe("site");
  });
});

describe("parseEvalArgs", () => {
  it("--from потребує --run; --only — лише з --from; етап перевіряється", () => {
    expect(() => parseEvalArgs(["--from", "codegen"], tmp)).toThrow(/--run/);
    expect(() => parseEvalArgs(["--only"], tmp)).toThrow(/--from/);
    expect(() => parseEvalArgs(["--from", "crawl", "--run", "x"], tmp)).toThrow(/невідомий етап/);
    const args = parseEvalArgs(
      ["--from=render", "--run", "2026-10-06-1530", "--only", "--parallel", "3"],
      tmp,
    );
    expect(args).toMatchObject({ from: "render", run: "2026-10-06-1530", only: true, parallel: 3 });
    expect(args.sites).toBe(path.join(tmp, "eval", "sites.json"));
  });

  it("невідомий аргумент — код 2 і підказка", async () => {
    const lines: string[] = [];
    expect(await runEvalCli(["--bogus"], { print: (l) => lines.push(l) })).toBe(2);
    expect(lines.join("\n")).toContain("Використання");
  });

  it("runName не перезаписує наявний прогін", async () => {
    const now = new Date(2026, 9, 6, 15, 30);
    expect(runName(now, tmp)).toBe("2026-10-06-1530");
    await writeFile(path.join(tmp, "2026-10-06-1530"), "");
    expect(runName(now, tmp)).toBe("2026-10-06-1530-2");
    expect(runName(now, tmp, ".from-qa")).toBe("2026-10-06-1530.from-qa");
  });
});

describe("prepareRerun", () => {
  async function delivered(storage: LocalStorage) {
    const project = fixtureProject({
      id: "p1",
      status: "delivered",
      origin: "eval",
      formats: ["vertical", "square"],
      brandkitVersion: 2,
      phase: "revision",
      branches: { video: "done", audio: "done" },
      firstDeliveredAt: "2026-10-06T10:00:00.000Z",
      deliveredAt: "2026-10-06T10:00:00.000Z",
    });
    await storage.writeJson(projectPaths("p1").project, project);
    const rev = projectPaths("p1").rev(1);
    await storage.writeJson(rev.storyboard, fixtureStoryboard);
    await storage.write(rev.scenesIndex, "export default {};\n");
    await storage.writeJson(rev.audio, { music: null, sfx: [], totalFrames: 450 });
    await storage.writeJson(
      rev.pipeline,
      PipeState.parse({
        attempts: { codegen: 1, check: 2, render: 0, "render:vertical": 1, "render:square": 1 },
        fixRounds: { s2: 1 },
        qaRounds: 1,
        templateScenes: ["s3"],
        dirtyScenes: ["s1"],
      }),
    );
  }

  it("render: стан rendering, по job на формат з новими спробами", async () => {
    const storage = new LocalStorage(tmp);
    await delivered(storage);
    const jobs = await prepareRerun(storage, "p1", "render", new Date("2026-10-07T00:00:00Z"));
    expect(jobs.map((j) => j.jobId)).toEqual(["p1.render.r1.a2.vertical", "p1.render.r1.a2.square"]);
    const project = await storage.readJson(projectPaths("p1").project, (v) => ProjectState.parse(v));
    expect(project).toMatchObject({ status: "rendering", phase: "first_delivery", firstDeliveredAt: null });
    const pipe = await storage.readJson(projectPaths("p1").rev(1).pipeline, (v) => PipeState.parse(v));
    expect(pipe.outstanding.map((j) => j.jobId)).toEqual(jobs.map((j) => j.jobId));
    expect(pipe.templateScenes).toEqual(["s3"]); // рендер не чіпає вибір шаблонних сцен
  });

  it("codegen: відео з нуля (лічильники фіксів скинуто), аудіо лишається готовим", async () => {
    const storage = new LocalStorage(tmp);
    await delivered(storage);
    const [job] = await prepareRerun(storage, "p1", "codegen");
    expect(job).toMatchObject({ stage: "codegen", attempt: 2, params: { sceneIds: null, instructions: [] } });
    const project = await storage.readJson(projectPaths("p1").project, (v) => ProjectState.parse(v));
    expect(project).toMatchObject({ status: "directing", branches: { video: "running", audio: "done" } });
    const pipe = await storage.readJson(projectPaths("p1").rev(1).pipeline, (v) => PipeState.parse(v));
    expect(pipe).toMatchObject({ fixRounds: {}, qaRounds: 0, templateScenes: [], videoPhase: "build" });
  });

  it("без потрібних артефактів — зрозуміла помилка", async () => {
    const storage = new LocalStorage(tmp);
    await storage.writeJson(projectPaths("p2").project, fixtureProject({ id: "p2", brandkitVersion: 1 }));
    await expect(prepareRerun(storage, "p2", "render")).rejects.toThrow(/розкадровки/);
    await expect(prepareRerun(storage, "p2", "brandkit")).resolves.toHaveLength(1);
  });
});

describe("звіт", () => {
  const site = (over: Partial<SiteReport>): SiteReport => ({
    name: "01-a",
    site: "https://a.example.com/",
    projectId: "p",
    status: "delivered",
    delivered: true,
    error: null,
    formats: ["vertical"],
    videoSeconds: 20,
    scenes: 5,
    firstTryScenes: 4,
    templateScenes: 0,
    qaFirstPass: true,
    qaWarnings: { critical: 0, major: 1, minor: 2 },
    usd: 2,
    usdByStage: [
      { key: "codegen", usd: 1.2 },
      { key: "brandkit", usd: 0.8 },
    ],
    usdByProvider: [{ key: "anthropic", usd: 2 }],
    llmCalls: 6,
    wallSeconds: 300,
    machineSeconds: 240,
    files: [],
    ...over,
  });

  it("summarize: частки першої спроби, QA pass і шаблонів; вартість лише готових", () => {
    const s = summarize([
      site({}),
      site({ name: "02-b", usd: 4, firstTryScenes: 2, templateScenes: 1, qaFirstPass: false }),
      site({
        name: "03-c",
        status: "failed",
        delivered: false,
        usd: 0.5,
        scenes: 0,
        firstTryScenes: 0,
        qaFirstPass: null,
      }),
    ]);
    expect(s).toMatchObject({ sites: 3, delivered: 2, failed: 1, totalUsd: 6.5 });
    expect(s.usdPerDelivered).toMatchObject({ count: 2, mean: 3, max: 4 });
    expect(s.firstTryShare).toBe(0.6);
    expect(s.qaPassShare).toBe(0.5);
    expect(s.templateShare).toBe(0.1);
    expect(s.usdByStage[0]).toEqual({ key: "codegen", usd: 3.6 });
  });

  it("reportMarkdown: таблиці підсумку й сайтів", () => {
    const sites = [
      site({}),
      site({ name: "02-b", status: "failed", delivered: false, error: "crawl: сайт недоступний" }),
    ];
    const report: EvalReport = {
      run: "2026-10-06-1530",
      startedAt: "2026-10-06T15:30:00.000Z",
      finishedAt: "2026-10-06T16:00:00.000Z",
      from: null,
      baseRun: null,
      only: false,
      sites,
      summary: summarize(sites),
    };
    const md = reportMarkdown(report);
    expect(md).toContain("# Eval 2026-10-06-1530");
    expect(md).toContain("| Сайтів / готових / не дійшли | 2 / 1 / 1 |");
    expect(md).toContain("| 02-b | failed — crawl: сайт недоступний |");
    expect(md).toContain("Сцени, що скомпілювались з першої спроби | 80%");
  });
});
