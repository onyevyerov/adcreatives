import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createStereo,
  decodeWav,
  encodeWav,
  loadSfxLibrary,
  PUBLIC_MIX_FILE,
  PUBLIC_MUSIC_FILE,
  renderSoundtrack,
  type SfxSample,
  type StereoPcm,
  sfxHash,
} from "@adc/audio";
import { PipeState } from "@adc/pipeline";
import {
  computeEventPlacements,
  createCostRecorder,
  createMockAnthropic,
  createPromptLoader,
  createTracer,
  type FilmReview,
  LocalStorage,
  loadPrices,
  ProjectState,
  projectPaths,
  RenderMeta,
  type ReviewIssue,
  readTuning,
  type SoundCue,
  type SoundSheet,
  type SoundSheetEvent,
  type Stage,
  StageError,
  type Storyboard,
  sharedPaths,
} from "@adc/shared";
import { fixtureAudioManifest, fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { createStageRegistry } from "@adc/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyGenerationMode,
  buildCaseReport,
  buildSiteReport,
  type CaseReport,
  caseReportMarkdown,
  type EvalReport,
  loadSites,
  measureAudioFile,
  measureCaseAudio,
  parseEvalArgs,
  prepareRerun,
  RERUN_STAGES,
  readEpidemicUsed,
  readSiteAudio,
  reportMarkdown,
  reviewStats,
  runEvalCli,
  runName,
  type SiteReport,
  slugify,
  soundSheetStats,
  summarize,
} from "../src/eval.ts";

let tmp: string;
const savedEpidemicDir = process.env.ADC_EPIDEMIC_DIR;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "adc-eval-"));
  // Лічильник Epidemic — лише в тимчасовій теці: тести не читають справжній `.data/epidemic`.
  process.env.ADC_EPIDEMIC_DIR = path.join(tmp, "epidemic");
});
afterEach(async () => {
  if (savedEpidemicDir === undefined) delete process.env.ADC_EPIDEMIC_DIR;
  else process.env.ADC_EPIDEMIC_DIR = savedEpidemicDir;
  await rm(tmp, { recursive: true, force: true });
});

/** Тимчасово виставляє env (undefined — видаляє) на час `fn`, потім відкочує. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (v: Record<string, string | undefined>) => {
    for (const [k, value] of Object.entries(v)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  };
  put(vars);
  try {
    return await fn();
  } finally {
    put(saved);
  }
}

const ELEVEN = { musicProvider: "elevenlabs", sfxProvider: "elevenlabs" } as const;
const NO_EPIDEMIC: SiteReport["audio"] = { ...ELEVEN, epidemic: null };

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

  it("репозиторний eval/sites.json валідний і містить кейс паритету webreportio-parity", async () => {
    const args = parseEvalArgs([]);
    const sites = await loadSites(args.sites);
    expect(sites.find((s) => s.name === "webreportio-parity")).toEqual({
      name: "webreportio-parity",
      url: "https://webreportio.com/",
      text: null,
      formats: ["landscape"],
      language: "uk",
      photos: [],
      durationSeconds: 25,
    });
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

  it("--from sfx / review: звукорежисер і рецензент — етапи перезапуску", () => {
    expect(RERUN_STAGES).toEqual([
      "brandkit",
      "storyboard",
      "codegen",
      "check",
      "qa",
      "sfx",
      "audio",
      "review",
      "render",
    ]);
    expect(parseEvalArgs(["--from", "sfx", "--run", "r"], tmp)).toMatchObject({ from: "sfx", run: "r" });
    expect(parseEvalArgs(["--from=review", "--run", "r", "--only"], tmp)).toMatchObject({
      from: "review",
      only: true,
    });
  });

  it("--case, --mode, --case-out, --audio/--bpm; звіти кейсів поруч із прогонами", () => {
    const args = parseEvalArgs(["--", "--case", "webreportio-parity", "--mode", "agent"], tmp);
    expect(args).toMatchObject({ caseName: "webreportio-parity", mode: "agent", audio: null, bpm: null });
    expect(args.caseOut).toBe(path.join(tmp, "eval", "out"));
    expect(parseEvalArgs(["--out", path.join(tmp, "r")], tmp).caseOut).toBe(path.join(tmp, "out"));
    expect(parseEvalArgs(["--case-out", path.join(tmp, "c")], tmp).caseOut).toBe(path.join(tmp, "c"));
    expect(parseEvalArgs([], tmp).mode).toBeNull();
    expect(parseEvalArgs(["--audio", "a.wav", "--bpm=120"], tmp)).toMatchObject({
      audio: path.resolve("a.wav"),
      bpm: 120,
    });
    expect(() => parseEvalArgs(["--mode", "turbo"], tmp)).toThrow(/невідомий режим/);
    expect(() => parseEvalArgs(["--case", "x", "--from", "qa", "--run", "r"], tmp)).toThrow(/--case/);
    expect(() => parseEvalArgs(["--bpm", "120"], tmp)).toThrow(/--audio/);
  });

  it("applyGenerationMode ставить ADC_GENERATION_MODE і відкочує", () => {
    const env: NodeJS.ProcessEnv = {};
    const restore = applyGenerationMode("agent", env);
    expect(readTuning(env).generationMode).toBe("agent");
    restore();
    expect("ADC_GENERATION_MODE" in env).toBe(false);
    const env2: NodeJS.ProcessEnv = { ADC_GENERATION_MODE: "agent" };
    const restore2 = applyGenerationMode("pipeline", env2);
    expect(env2.ADC_GENERATION_MODE).toBe("pipeline");
    restore2();
    expect(env2.ADC_GENERATION_MODE).toBe("agent");
    applyGenerationMode(null, env2)();
    expect(env2.ADC_GENERATION_MODE).toBe("agent");
  });

  it("невідомий кейс — код 2 і перелік кейсів (до перевірки ключів API)", async () => {
    const sites = path.join(tmp, "sites.json");
    await writeFile(sites, JSON.stringify([{ url: "https://a.example.com/", name: "a" }]));
    const lines: string[] = [];
    const code = await runEvalCli(["--sites", sites, "--out", path.join(tmp, "runs"), "--case", "b"], {
      print: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/кейс «b» не знайдено.*Є: a/);
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
        reviewRounds: 1,
        templateScenes: ["s3"],
        dirtyScenes: ["s1"],
      }),
    );
  }
  const readPipe = (storage: LocalStorage) =>
    storage.readJson(projectPaths("p1").rev(1).pipeline, (v) => PipeState.parse(v));
  const readProject = (storage: LocalStorage) =>
    storage.readJson(projectPaths("p1").project, (v) => ProjectState.parse(v));

  it("render: стан rendering, по job на формат з новими спробами", async () => {
    const storage = new LocalStorage(tmp);
    await delivered(storage);
    const metaKey = projectPaths("p1").rev(1).renderMeta("vertical");
    await storage.writeJson(metaKey, { inputsHash: "abc123" });
    const jobs = await prepareRerun(storage, "p1", "render", new Date("2026-10-07T00:00:00Z"));
    // хеш входів попереднього рендеру скинуто: job рендерить заново, а не перевикористовує mp4
    expect((await storage.readJson(metaKey, (v) => RenderMeta.parse(v))).inputsHash).not.toBe("abc123");
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
    const [job] = await prepareRerun(storage, "p1", "codegen", new Date(), "storyboard");
    expect(job).toMatchObject({ stage: "codegen", attempt: 2, params: { sceneIds: null, instructions: [] } });
    const project = await storage.readJson(projectPaths("p1").project, (v) => ProjectState.parse(v));
    expect(project).toMatchObject({ status: "directing", branches: { video: "running", audio: "done" } });
    const pipe = await storage.readJson(projectPaths("p1").rev(1).pipeline, (v) => PipeState.parse(v));
    expect(pipe).toMatchObject({ fixRounds: {}, qaRounds: 0, templateScenes: [], videoPhase: "build" });
    expect(pipe).toMatchObject({ sfxMode: "storyboard", reviewRounds: 0 });
  });

  it("qa у режимі designer: після відео — sfx і зведення (трек попереднього прогону готовий)", async () => {
    const storage = new LocalStorage(tmp);
    await delivered(storage);
    const [job] = await prepareRerun(storage, "p1", "qa", new Date(), "designer");
    expect(job).toMatchObject({ stage: "qa", params: { sceneIds: null } });
    expect(await readProject(storage)).toMatchObject({
      status: "directing",
      branches: { video: "running", audio: "running" },
    });
    expect(await readPipe(storage)).toMatchObject({
      sfxMode: "designer",
      musicDone: true,
      sfxDone: false,
      reviewRounds: 0,
      pendingSfx: null,
    });
    await prepareRerun(storage, "p1", "qa", new Date(), "storyboard");
    expect((await readProject(storage)).branches).toEqual({ video: "running", audio: "done" });
    expect((await readPipe(storage)).sfxMode).toBe("storyboard");
  });

  it("audio: фаза за режимом звуку — designer → music (план SFX уже є), storyboard → full", async () => {
    const storage = new LocalStorage(tmp);
    await delivered(storage);
    const [music] = await prepareRerun(storage, "p1", "audio", new Date(), "designer");
    expect(music).toMatchObject({ stage: "audio", attempt: 1, params: { phase: "music" } });
    expect(await readProject(storage)).toMatchObject({ branches: { video: "done", audio: "running" } });
    // music → (sfx готовий) → mix → review: зведення машина поставить сама після треку.
    expect(await readPipe(storage)).toMatchObject({
      sfxMode: "designer",
      musicDone: false,
      sfxDone: true,
      reviewRounds: 0,
    });
    const [full] = await prepareRerun(storage, "p1", "audio", new Date(), "storyboard");
    expect(full).toMatchObject({ stage: "audio", attempt: 2, params: { phase: "full" } });
    expect((await readPipe(storage)).sfxMode).toBe("storyboard");
  });

  it("sfx і review: звукорежисер по всіх сценах, рецензія з кола 0; sfx — лише в режимі designer", async () => {
    const storage = new LocalStorage(tmp);
    await delivered(storage);
    const [sfx] = await prepareRerun(storage, "p1", "sfx", new Date(), "designer");
    expect(sfx).toMatchObject({ jobId: "p1.sfx.r1.a1", params: { sceneIds: null, instructions: [] } });
    expect(await readProject(storage)).toMatchObject({
      status: "directing",
      branches: { video: "running", audio: "running" },
    });
    expect(await readPipe(storage)).toMatchObject({
      sfxMode: "designer",
      musicDone: true,
      sfxDone: false,
      reviewRounds: 0,
      changedScenes: null,
      outstanding: [expect.objectContaining({ stage: "sfx" })],
    });

    const [review] = await prepareRerun(storage, "p1", "review", new Date(), "designer");
    expect(review).toMatchObject({ jobId: "p1.review.r1.a1", params: { round: 0 } });
    expect(await readProject(storage)).toMatchObject({
      status: "directing",
      branches: { video: "done", audio: "done" },
    });
    expect(await readPipe(storage)).toMatchObject({ musicDone: true, sfxDone: true, reviewRounds: 0 });

    await expect(prepareRerun(storage, "p1", "sfx", new Date(), "storyboard")).rejects.toThrow(
      /ADC_SFX_MODE=designer/,
    );
    // Рецензію можна поставити й фільму режиму storyboard (з --only — лише оцінка).
    await expect(prepareRerun(storage, "p1", "review", new Date(), "storyboard")).resolves.toHaveLength(1);
  });

  it("без потрібних артефактів — зрозуміла помилка", async () => {
    const storage = new LocalStorage(tmp);
    await storage.writeJson(projectPaths("p2").project, fixtureProject({ id: "p2", brandkitVersion: 1 }));
    await expect(prepareRerun(storage, "p2", "render")).rejects.toThrow(/розкадровки/);
    await expect(prepareRerun(storage, "p2", "brandkit")).resolves.toHaveLength(1);
    // review — після зведення: без audio.json неможливий.
    await storage.writeJson(projectPaths("p3").project, fixtureProject({ id: "p3", brandkitVersion: 1 }));
    await storage.writeJson(projectPaths("p3").rev(1).storyboard, fixtureStoryboard);
    await storage.write(projectPaths("p3").rev(1).scenesIndex, "export default {};\n");
    await expect(prepareRerun(storage, "p3", "review", new Date(), "designer")).rejects.toThrow(
      /audio\.json/,
    );
    await expect(prepareRerun(storage, "p3", "sfx", new Date(), "designer")).resolves.toHaveLength(1);
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
    review: null,
    sound: null,
    usd: 2,
    usdByStage: [
      { key: "codegen", usd: 1.2 },
      { key: "brandkit", usd: 0.8 },
    ],
    usdByProvider: [{ key: "anthropic", usd: 2 }],
    llmCalls: 6,
    wallSeconds: 300,
    machineSeconds: 240,
    audio: NO_EPIDEMIC,
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
      mode: "pipeline",
      soundMode: { sfxMode: "designer", filmReview: true, reviewMaxRounds: 1, ...ELEVEN },
      from: null,
      baseRun: null,
      only: false,
      sites,
      epidemicUsed: null,
      summary: summarize(sites),
    };
    const md = reportMarkdown(report);
    expect(md).toContain("# Eval 2026-10-06-1530");
    expect(md).toContain("Режим генерації: pipeline. Звук: designer, рецензія on (кіл ≤ 1).");
    expect(md).toContain("| Сайтів / готових / не дійшли | 2 / 1 / 1 |");
    expect(md).toContain("| 02-b | failed — crawl: сайт недоступний |");
    expect(md).toContain("Сцени, що скомпілювались з першої спроби | 80%");
  });
});

// ───────────────────────────── кейс паритету ─────────────────────────────

const SR = 44_100;
const decode = async (bytes: Buffer) => decodeWav(bytes);

/** «Трек»: бочка на кожну долю + тихий пед (як справжня музика для онсетів і RMS). */
function drumLoop(seconds: number, bpm: number): StereoPcm {
  const pcm = createStereo(Math.round(seconds * SR), SR);
  const beat = Math.round((60 / bpm) * SR);
  for (let i = 0; i < pcm.left.length; i++) {
    const since = (i % beat) / SR;
    const v =
      Math.exp(-since * 20) * Math.sin(2 * Math.PI * 55 * since) * 0.6 +
      0.12 * Math.sin((2 * Math.PI * 220 * i) / SR);
    pcm.left[i] = v;
    pcm.right[i] = v;
  }
  return pcm;
}

/** Семпл події: короткий тон з атакою і згасанням. */
function burst(freq: number, seconds = 0.4): StereoPcm {
  const pcm = createStereo(Math.round(seconds * SR), SR);
  for (let i = 0; i < pcm.left.length; i++) {
    const t = i / SR;
    const v = Math.min(1, t / 0.005) * Math.exp(-t * 8) * Math.sin(2 * Math.PI * freq * t) * 0.8;
    pcm.left[i] = v;
    pcm.right[i] = v;
  }
  return pcm;
}

/** Розкадровка-фікстура (15 с, 85 BPM), уся музика `full` — є секунди без подій. */
const caseStoryboard: Storyboard = {
  ...fixtureStoryboard,
  musicBrief: {
    ...fixtureStoryboard.musicBrief,
    structure: [{ label: "all", sceneIds: ["s1", "s2", "s3"], energy: 0.6, mix: "full" }],
  },
};

/** Артефакти стадії `audio`: трек, план, music.json, кеш SFX, audio.json, soundtrack.wav. */
async function writeAudioArtifacts(storage: LocalStorage, projectId: string): Promise<Buffer> {
  const paths = projectPaths(projectId);
  const rev = paths.rev(1);
  await storage.writeJson(rev.storyboard, caseStoryboard);
  await storage.writeJson(rev.audioPlan, { key: "A minor" });
  await storage.writeJson(rev.audio, {
    ...fixtureAudioManifest,
    music: { ...fixtureAudioManifest.music, planHash: "ph1" },
  });
  await storage.writeJson(paths.musicMeta("ph1"), {
    planHash: "ph1",
    durationMs: 16_000,
    modelId: "music_v2_5",
    method: "compose",
    promptUsed: null,
    briefHash: "b",
    createdAt: "2026-10-12T00:00:00.000Z",
    check: { bpm: 85, kickOnsets: 21, beatConfidence: 0.9, gaps: [], rmsPerSecondDb: [-14, -14], ok: true },
    attempts: 2,
    offsetMs: 2824,
  });
  const musicBytes = encodeWav(drumLoop(16, 85));
  await storage.write(rev.publicFile(PUBLIC_MUSIC_FILE), musicBytes);
  // Семпли — як у стадії: усі варіанти бібліотеки для cue подій, у спільному кеші.
  const library = loadSfxLibrary(createPromptLoader());
  const cues = [
    ...new Set(
      computeEventPlacements(caseStoryboard)
        .map((p) => p.cue)
        .filter((c): c is SoundCue => c !== null),
    ),
  ];
  const samples: Partial<Record<SoundCue, SfxSample[]>> = {};
  for (const [c, cue] of cues.entries()) {
    for (const [i, def] of library[cue].entries()) {
      const bytes = encodeWav(burst(330 + 110 * c + 40 * i));
      await storage.write(sharedPaths.sfxCache(sfxHash(def)), bytes);
      samples[cue] = [
        ...(samples[cue] ?? []),
        { cue, variant: i + 1, hash: sfxHash(def), pcm: decodeWav(bytes) },
      ];
    }
  }
  const soundtrack = renderSoundtrack({
    music: decodeWav(musicBytes),
    storyboard: caseStoryboard,
    key: "A minor",
    samples,
  });
  await storage.write(rev.publicFile(PUBLIC_MIX_FILE), soundtrack.wav);
  return soundtrack.wav;
}

const caseSite = (over: Partial<SiteReport> = {}): SiteReport => ({
  name: "01-parity",
  site: "https://zerno.example.com/",
  projectId: "p1",
  status: "delivered",
  delivered: true,
  error: null,
  formats: ["landscape"],
  videoSeconds: 15,
  scenes: 3,
  firstTryScenes: 3,
  templateScenes: 0,
  qaFirstPass: true,
  qaWarnings: { critical: 0, major: 0, minor: 0 },
  review: null,
  sound: null,
  usd: 1.5,
  usdByStage: [{ key: "codegen", usd: 1.5 }],
  usdByProvider: [{ key: "anthropic", usd: 1.5 }],
  llmCalls: 1,
  wallSeconds: 600,
  machineSeconds: 300,
  audio: NO_EPIDEMIC,
  files: [],
  ...over,
});

describe("звук кейсу", () => {
  it("стеми: повторне зведення збігається з soundtrack.wav побайтно → рівні музики й подій", async () => {
    const storage = new LocalStorage(tmp);
    await writeAudioArtifacts(storage, "p1");
    const audio = await measureCaseAudio(storage, "p1", 1, caseStoryboard, { decode });
    // Зведення v3 (A1) має стем reverb.
    expect(audio).toMatchObject({ source: "stems", note: null, reverb: { rmsDb: expect.any(Number) } });
    expect(audio.mix?.perSecondDb).toHaveLength(15);
    expect(audio.mix?.peakDb).toBeLessThanOrEqual(-1);
    expect(audio.beat).toMatchObject({ bpm: 85 });
    expect(audio.beat?.onsets).toBeGreaterThan(10);
    expect(audio.musicGainDb).toEqual(expect.any(Number));
    // Фікстура audio.json без мастера (mix: null) — старе зведення: null, а не падіння.
    expect(audio).toMatchObject({ integratedLufs: null, truePeakDbtp: null, masterGainDb: null });
    expect(audio.mixLowCorrelation).toBeGreaterThanOrEqual(0.9);
    expect(audio).toMatchObject({ keyPlanned: "A minor", keyDetected: null, attempts: 2, offsetMs: 2824 });
    // whoosh (s1, 0 с), pop + impact (s2), shimmer (s3).
    expect(audio.events?.count).toBe(4);
    expect(audio.events?.list.map((e) => e.cue).sort()).toEqual(["impact", "pop", "shimmer", "whoosh"]);
    expect(audio.events?.maxOverMusicDb).toEqual(expect.any(Number));
    const outside = audio.music?.outsideEvents;
    expect(outside?.seconds.length).toBeGreaterThan(0);
    expect(outside?.seconds).not.toContain(0); // whoosh на 0 с
    expect(outside?.seconds).not.toContain(14); // остання секунда — fade-out
    expect(outside?.minDb).toEqual(expect.any(Number));
  });

  it("зведення не відтворилось побайтно — оцінка по міксу з причиною", async () => {
    const storage = new LocalStorage(tmp);
    await writeAudioArtifacts(storage, "p1");
    // Інший трек у public: перезведення вже не збігається з soundtrack.wav.
    await storage.write(
      projectPaths("p1").rev(1).publicFile(PUBLIC_MUSIC_FILE),
      encodeWav(drumLoop(16, 120)),
    );
    const audio = await measureCaseAudio(storage, "p1", 1, caseStoryboard, { decode });
    expect(audio.source).toBe("mix");
    expect(audio.note).toMatch(/не збіглося з soundtrack\.wav.*оцінка по міксу/);
    expect(audio.events?.count).toBe(4);
    expect(audio.music?.outsideEvents.minDb).toEqual(expect.any(Number));
  });

  it("без треку — оцінка по міксу; без soundtrack.wav — метрик немає, але є причина", async () => {
    const storage = new LocalStorage(tmp);
    await writeAudioArtifacts(storage, "p1");
    await rm(storage.absPath(projectPaths("p1").rev(1).publicFile(PUBLIC_MUSIC_FILE)));
    const noTrack = await measureCaseAudio(storage, "p1", 1, caseStoryboard, { decode });
    expect(noTrack).toMatchObject({ source: "mix" });
    expect(noTrack.note).toMatch(/немає файлу треку/);
    const empty = await measureCaseAudio(storage, "p2", 1, caseStoryboard, { decode });
    expect(empty).toMatchObject({
      source: null,
      mix: null,
      music: null,
      events: null,
      integratedLufs: null,
      keyPlanned: null,
      mixLowCorrelation: null,
      attempts: null,
    });
    expect(empty.note).toMatch(/soundtrack\.wav/);
  });

  it("--audio міряє будь-який WAV (еталонну доріжку)", async () => {
    const file = path.join(tmp, "ref.wav");
    await writeFile(file, encodeWav(drumLoop(4, 120)));
    const m = await measureAudioFile(file, 120);
    expect(m.seconds).toBe(4);
    expect(m.levels.perSecondDb).toHaveLength(4);
    expect(m.beat).toMatchObject({ bpm: 120 });
    expect(m.beat.confidence).toBeGreaterThan(0.8);
    const lines: string[] = [];
    expect(await runEvalCli(["--audio", file], { print: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ seconds: 4, beat: { bpm: null } });
    expect(await runEvalCli(["--audio", path.join(tmp, "nope.wav")], { print: () => {} })).toBe(2);
  });
});

describe("звіт кейсу", () => {
  it("$, токени й хвилини з costs/trace (лише цей прогін), трек, удари, критерії", async () => {
    const storage = new LocalStorage(tmp);
    await storage.writeJson(
      projectPaths("p1").project,
      fixtureProject({ id: "p1", status: "delivered", durationSeconds: 25, formats: ["landscape"] }),
    );
    await writeAudioArtifacts(storage, "p1");
    // Зведення й трек після ТЗ звуку: мастер у audio.json, тональність/такт/стерео в music.json.
    const rp = projectPaths("p1");
    await storage.writeJson(rp.rev(1).audio, {
      ...fixtureAudioManifest,
      music: { ...fixtureAudioManifest.music, planHash: "ph1" },
      mix: {
        src: PUBLIC_MIX_FILE,
        durationMs: 15_000,
        integratedLufs: -14.3,
        truePeakDbtp: -1.2,
        masterGainDb: 2.5,
      },
    });
    const meta = JSON.parse(await readFile(storage.absPath(rp.musicMeta("ph1")), "utf8"));
    await storage.writeJson(rp.musicMeta("ph1"), {
      ...meta,
      check: {
        ...meta.check,
        keyDetected: { root: 9, minor: true, confidence: 0.42 },
        barOffsetMs: 0,
        barConfidence: 0.8,
        stereoCorrelation: 0.71,
        lowCorrelation: 0.97,
        integratedLufs: -12,
        truePeakDbtp: -0.4,
      },
    });
    const since = new Date("2026-10-12T10:00:00.000Z");
    const recorder = (at: string) =>
      createCostRecorder(
        storage,
        loadPrices(),
        { projectId: "p1", rev: 1, stage: "codegen", phase: "first_delivery", source: "eval", attempt: 1 },
        () => new Date(at),
      );
    const units = { input: 1000, output: 200, cacheWrite: 50, cacheWrite1h: 10, cacheRead: 3000 };
    await recorder("2026-10-12T09:00:00.000Z").record({
      provider: "anthropic",
      model: "claude-opus-5-5",
      units,
    });
    await recorder("2026-10-12T10:05:00.000Z").record({
      provider: "anthropic",
      model: "claude-opus-5-5",
      units,
    });
    const tracer = createTracer(storage, "p1");
    const trace = {
      rev: 1,
      attempt: 1,
      phase: "first_delivery" as const,
      jobId: null,
      ok: true,
      error: null,
    };
    await tracer.record({
      ...trace,
      stage: "codegen",
      startedAt: "2026-10-12T09:00:00.000Z",
      durationMs: 60_000,
    });
    await tracer.record({
      ...trace,
      stage: "codegen",
      startedAt: "2026-10-12T10:01:00.000Z",
      durationMs: 90_000,
    });
    await tracer.record({
      ...trace,
      stage: "audio",
      startedAt: "2026-10-12T10:02:00.000Z",
      durationMs: 30_000,
    });

    const report = await buildCaseReport(storage, "p1", {
      caseName: "parity",
      run: "2026-10-12-1000",
      since,
      site: caseSite(),
      mode: "agent",
      now: new Date("2026-10-12T11:00:00.000Z"),
      decode,
    });
    expect(report).toMatchObject({
      case: "parity",
      mode: "agent",
      durationSeconds: 25,
      cost: { usd: 1.5, tokens: { input: 1000, output: 200, cacheWrite: 60, cacheRead: 3000, total: 4260 } },
      time: {
        wallMinutes: 10,
        machineMinutes: 2,
        stages: [
          { stage: "codegen", runs: 1, minutes: 1.5 },
          { stage: "audio", runs: 1, minutes: 0.5 },
        ],
      },
      storyboard: { scenes: 3, seconds: 15, impactSlam: 1, impactSlamLimit: 3, impactSlamMaxIn3s: 1 },
      music: { planHash: "ph1", attempts: 2, offsetMs: 2824, check: { ok: true }, note: null },
      audio: {
        source: "stems",
        integratedLufs: -14.3,
        truePeakDbtp: -1.2,
        masterGainDb: 2.5,
        keyPlanned: "A minor",
        keyDetected: { root: 9, minor: true, confidence: 0.42 },
        barConfidence: 0.8,
        stereoCorrelation: 0.71,
        lowCorrelation: 0.97,
        attempts: 2,
        offsetMs: 2824,
      },
    });
    const byId = Object.fromEntries(report.criteria.map((c) => [c.id, c]));
    expect(byId.loudness).toMatchObject({ value: -14.3, ok: true });
    expect(byId.true_peak).toMatchObject({ value: -1.2, ok: true });
    expect(byId.low_mono?.ok).toBe(true);
    expect(byId.music_check).toMatchObject({ value: true, ok: true });
    expect(byId.impact_count).toMatchObject({ value: 1, ok: true });
    expect(byId.music_level?.ok).toEqual(expect.any(Boolean));
    expect(byId.event_peaks?.ok).toEqual(expect.any(Boolean));
    expect(byId.live_background).toMatchObject({ ok: null, note: expect.stringContaining("вручну") });
    const md = caseReportMarkdown(report);
    expect(md).toContain("# Кейс parity — agent");
    expect(md).toContain("| MusicTrackCheck.ok | true | так |");
    expect(md).toContain("| Мастер: LUFS / dBTP / підсилення | -14.3 / -1.2 / +2.5 дБ |");
    expect(md).toContain("| Тональність: план / трек | A minor / A minor (0.42) |");
  });

  it("старий music.json без check і порожній проєкт — null з причиною, а не падіння", async () => {
    const storage = new LocalStorage(tmp);
    await writeAudioArtifacts(storage, "p1");
    const metaKey = projectPaths("p1").musicMeta("ph1");
    const meta = JSON.parse(await readFile(storage.absPath(metaKey), "utf8")) as Record<string, unknown>;
    delete meta.check;
    delete meta.attempts;
    delete meta.offsetMs;
    await storage.writeJson(metaKey, meta);
    const r = await buildCaseReport(storage, "p1", {
      caseName: "old",
      run: "r",
      since: new Date(0),
      site: caseSite(),
      mode: "pipeline",
      decode,
    });
    expect(r.music).toMatchObject({ check: null, attempts: 1, offsetMs: null });
    expect(r.criteria.find((c) => c.id === "music_check")).toMatchObject({ ok: null });
    // Старі audio.json/music.json: нові поля звуку — null, критерії мастера не виміряні.
    expect(r.audio).toMatchObject({
      integratedLufs: null,
      truePeakDbtp: null,
      masterGainDb: null,
      keyDetected: null,
      barConfidence: null,
      stereoCorrelation: null,
      attempts: 1,
      offsetMs: null,
    });
    expect(r.criteria.find((c) => c.id === "loudness")).toMatchObject({ ok: null });
    expect(r.criteria.find((c) => c.id === "true_peak")).toMatchObject({ ok: null });

    const none = await buildCaseReport(storage, "nobody", {
      caseName: "none",
      run: "r",
      since: new Date(0),
      site: caseSite({ status: "missing", delivered: false }),
      mode: "pipeline",
      decode,
    });
    expect(none).toMatchObject({ storyboard: null, audio: { source: null }, music: { check: null } });
    expect(none.criteria.every((c) => c.ok === null)).toBe(true);
    // Без review.json і sound-sheet.json (старі прогони) — null і прочерки в таблиці, а не падіння.
    expect(r).toMatchObject({ review: null, sound: null });
    expect(caseReportMarkdown(r)).toContain("| old | — | — | — | — | — | — | — | — | — |");
  });
});

// ───────────────────────────── звук і рецензія ─────────────────────────────

const sheetEvent = (over: Partial<SoundSheetEvent>): SoundSheetEvent => ({
  sceneId: "s1",
  eventId: "e",
  cue: "whoosh",
  accent: "normal",
  frame: 0,
  ms: 0,
  beatIndex: 0,
  beatOffsetMs: 0,
  peakDb: -12,
  ducked: false,
  silent: "none",
  ...over,
});

/** Відомість: 8 подій — 2 повз долю (не grid-cue), 1 важкий удар, 1 вимкнена, 1 без семпла; 1 старт поза тактом. */
const fixtureSheet: SoundSheet = {
  version: 1,
  fps: 30,
  bpm: 120,
  totalFrames: 450,
  beatShiftMs: 0,
  beatConfidence: 0.9,
  barOffsetMs: 0,
  sceneStarts: [
    { sceneId: "s1", frame: 0, beatOffsetMs: 0, onBar: true },
    { sceneId: "s2", frame: 150, beatOffsetMs: 0, onBar: false },
    { sceneId: "s3", frame: 300, beatOffsetMs: null, onBar: null },
  ],
  sections: [],
  events: [
    sheetEvent({ eventId: "e1", cue: "whoosh", beatOffsetMs: 120 }), // grid-cue: зсув не рахується
    sheetEvent({ eventId: "e2", cue: "typing", beatOffsetMs: 25 }), // повз долю
    sheetEvent({ eventId: "e3", cue: "tick", beatOffsetMs: -20 }), // повз долю (поріг включно, в обидва боки)
    sheetEvent({ eventId: "e4", cue: "click", beatOffsetMs: 19.9 }),
    sheetEvent({ eventId: "e5", cue: "scan", beatIndex: null, beatOffsetMs: null }), // доля не визначена
    sheetEvent({ eventId: "e6", cue: "impact", beatOffsetMs: 0 }), // важкий удар
    sheetEvent({ eventId: "e7", cue: "slide", beatOffsetMs: 300, peakDb: null, silent: "muted" }),
    sheetEvent({ eventId: "e8", cue: "drop", peakDb: null, silent: "no_sample" }),
  ],
  rmsPerSecondDb: [-14, -14],
  integratedLufs: -14,
  truePeakDbtp: -1,
};

const reviewIssue = (kind: ReviewIssue["kind"], severity: ReviewIssue["severity"]): ReviewIssue => ({
  scope: "scene",
  sceneId: "s2",
  nextSceneId: null,
  eventId: null,
  frame: null,
  format: null,
  severity,
  kind,
  description: "d",
  fix: "f",
});

const fixtureReview: FilmReview = {
  version: 1,
  round: 1,
  inputsHash: "h",
  verdict: "fix",
  score: 6,
  summary: "Історія тримається; у s2 каша зі звуків.",
  issues: [
    reviewIssue("join_break", "major"),
    reviewIssue("sfx_excess", "critical"),
    reviewIssue("sfx_off_beat", "minor"),
    reviewIssue("music_level", "minor"),
  ],
  routes: { fix: ["s2", "s3"], sfx: ["s2"], music: 1 },
};

describe("звук і рецензія у звітах", () => {
  it("soundSheetStats: offBeat — лише події, що звучать, не grid-cue, |зсув| ≥ 20 мс; muted, удари, такти", () => {
    expect(soundSheetStats(fixtureSheet)).toEqual({
      events: 8,
      muted: 1,
      silent: 1,
      offBeat: 2,
      heavyHits: 1,
      sceneStartsOffBar: 1,
    });
  });

  it("reviewStats: оцінка, вердикт і лічильники за маршрутом (routeOf) і серйозністю", () => {
    expect(reviewStats(fixtureReview)).toEqual({
      score: 6,
      verdict: "fix",
      round: 1,
      summary: "Історія тримається; у s2 каша зі звуків.",
      issues: 4,
      byRoute: { fix: 1, sfx: 2, music: 1, none: 0 },
      bySeverity: { critical: 1, major: 1, minor: 2 },
    });
  });

  it("звіт сайту й кейсу читають review.json і sound-sheet.json; файли не за схемою — null", async () => {
    const storage = new LocalStorage(tmp);
    await storage.writeJson(projectPaths("p1").project, fixtureProject({ id: "p1", status: "delivered" }));
    const rev = projectPaths("p1").rev(1);
    await storage.writeJson(rev.storyboard, fixtureStoryboard);
    await storage.writeJson(rev.review, fixtureReview);
    await storage.writeJson(rev.soundSheet, fixtureSheet);

    const site = await buildSiteReport(storage, "p1", {
      name: "01-parity",
      since: new Date(0),
      wallSeconds: 60,
    });
    expect(site.review).toMatchObject({ score: 6, verdict: "fix", byRoute: { fix: 1, sfx: 2, music: 1 } });
    expect(site.sound).toMatchObject({ offBeat: 2, muted: 1, heavyHits: 1, sceneStartsOffBar: 1 });

    const report = await buildCaseReport(storage, "p1", {
      caseName: "parity",
      run: "r",
      since: new Date(0),
      site,
      mode: "pipeline",
      soundMode: { sfxMode: "designer", filmReview: true, reviewMaxRounds: 1, ...ELEVEN },
      decode,
    });
    expect(report).toMatchObject({
      soundMode: { sfxMode: "designer", filmReview: true },
      review: { score: 6, issues: 4 },
      sound: { events: 8, offBeat: 2, muted: 1 },
    });
    const md = caseReportMarkdown(report);
    expect(md).toContain("| Режим звуку | designer, рецензія on (кіл ≤ 1) |");
    expect(md).toContain("| Кейс | score | Вердикт | offBeat | muted |");
    expect(md).toContain("| parity | 6 | fix | 2 | 1 | 8 | 1 | 1 | 1/2/1 | 1/1/2 |");
    expect(md).toContain("Рецензент (коло 1): Історія тримається; у s2 каша зі звуків.");

    // Файли не за схемою (формат до Кроку 0) — як відсутні, звіт не падає.
    await storage.writeJson(rev.review, { verdict: "pass" });
    await storage.writeJson(rev.soundSheet, { events: "?" });
    const old = await buildSiteReport(storage, "p1", {
      name: "01-parity",
      since: new Date(0),
      wallSeconds: 60,
    });
    expect(old).toMatchObject({ review: null, sound: null });
  });

  it("reportMarkdown: таблиця по кейсах зі score, offBeat, muted; середня оцінка в підсумку", () => {
    const sites = [
      caseSite({ review: reviewStats(fixtureReview), sound: soundSheetStats(fixtureSheet) }),
      caseSite({ name: "02-old" }),
    ];
    const summary = summarize(sites);
    expect(summary.reviewScoreMean).toBe(6);
    expect(summarize([caseSite()]).reviewScoreMean).toBeNull();
    const md = reportMarkdown({
      run: "r",
      startedAt: "2026-10-15T10:00:00.000Z",
      finishedAt: "2026-10-15T11:00:00.000Z",
      mode: "pipeline",
      soundMode: { sfxMode: "storyboard", filmReview: false, reviewMaxRounds: 1, ...ELEVEN },
      from: null,
      baseRun: null,
      only: false,
      sites,
      epidemicUsed: null,
      summary,
    });
    expect(md).toContain("Звук: storyboard, рецензія off.");
    expect(md).toContain("| Оцінка рецензента, середня | 6 |");
    expect(md).toContain("## Звук і рецензія");
    expect(md).toContain("| 01-parity | 6 | fix | 2 | 1 | 8 | 1 | 1 | 1/2/1 | 1/1/2 |");
    expect(md).toContain("| 02-old | — | — | — | — | — | — | — | — | — |");
  });
});

describe("pnpm eval --case --mode (стадії-заглушки, без мережі й API)", () => {
  it("один кейс, ADC_GENERATION_MODE у воркері, тривалість у project.json, звіт кейсу в out/", async () => {
    const sites = path.join(tmp, "sites.json");
    await writeFile(
      sites,
      JSON.stringify([
        { url: "https://other.example.com/", name: "other" },
        {
          url: "https://parity.example.com/",
          name: "parity",
          formats: ["16:9"],
          language: "uk",
          durationSeconds: 25,
        },
      ]),
    );
    const seen: Array<{ mode: string; url: string | null; durationSeconds: number | null }> = [];
    const crawl: Stage<"crawl"> = async (ctx) => {
      const project = await ctx.storage.readJson(projectPaths(ctx.projectId).project, (v) =>
        ProjectState.parse(v),
      );
      seen.push({
        mode: readTuning().generationMode,
        url: ctx.params.url,
        durationSeconds: project.durationSeconds,
      });
      throw new StageError("заглушка", "stub_crawl", "Сайт недоступний (тест).", false);
    };
    const before = process.env.ADC_GENERATION_MODE;
    const runsDir = path.join(tmp, "runs");
    const lines: string[] = [];
    const code = await runEvalCli(
      ["--sites", sites, "--out", runsDir, "--case", "parity", "--mode", "agent"],
      {
        anthropic: createMockAnthropic([]),
        registry: createStageRegistry({ overrides: { crawl } }),
        print: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    expect(seen).toEqual([{ mode: "agent", url: "https://parity.example.com/", durationSeconds: 25 }]);
    expect(process.env.ADC_GENERATION_MODE).toBe(before);

    const caseFile = path.join(tmp, "out", "parity", "report.json");
    expect(existsSync(caseFile)).toBe(true);
    expect(existsSync(path.join(tmp, "out", "parity", "report.md"))).toBe(true);
    const report = JSON.parse(await readFile(caseFile, "utf8")) as CaseReport;
    expect(report).toMatchObject({
      case: "parity",
      mode: "agent",
      status: "failed",
      delivered: false,
      durationSeconds: 25,
      storyboard: null,
      audio: { source: null, note: expect.stringContaining("soundtrack.wav") },
    });
    expect(report.time.stages).toEqual([{ stage: "crawl", runs: 1, minutes: expect.any(Number) }]);
    const [run] = await readdir(runsDir);
    const runReport = JSON.parse(
      await readFile(path.join(runsDir, run as string, "report.json"), "utf8"),
    ) as EvalReport;
    expect(runReport.mode).toBe("agent");
    expect(runReport.sites.map((s) => s.name)).toEqual(["01-parity"]);
    expect(existsSync(path.join(runsDir, run as string, "sites", "01-parity", "case-report.json"))).toBe(
      true,
    );
    expect(lines.join("\n")).toContain("режим генерації agent");
  });

  it("ADC_SFX_MODE і ADC_FILM_REVIEW з env — у воркері eval і в звітах; невалідне значення — код 2", async () => {
    const sites = path.join(tmp, "sites.json");
    await writeFile(sites, JSON.stringify([{ url: "https://parity.example.com/", name: "parity" }]));
    const seen: Array<{ sfxMode: string; filmReview: boolean }> = [];
    const crawl: Stage<"crawl"> = async () => {
      const t = readTuning();
      seen.push({ sfxMode: t.sfxMode, filmReview: t.filmReview });
      throw new StageError("заглушка", "stub_crawl", "Сайт недоступний (тест).", false);
    };
    const saved = { sfx: process.env.ADC_SFX_MODE, review: process.env.ADC_FILM_REVIEW };
    const restore = () => {
      for (const [name, value] of [
        ["ADC_SFX_MODE", saved.sfx],
        ["ADC_FILM_REVIEW", saved.review],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
    const runsDir = path.join(tmp, "runs");
    const lines: string[] = [];
    try {
      process.env.ADC_SFX_MODE = "storyboard";
      process.env.ADC_FILM_REVIEW = "off";
      const code = await runEvalCli(["--sites", sites, "--out", runsDir, "--case", "parity"], {
        anthropic: createMockAnthropic([]),
        registry: createStageRegistry({ overrides: { crawl } }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(seen).toEqual([{ sfxMode: "storyboard", filmReview: false }]);
      const [run] = await readdir(runsDir);
      const runReport = JSON.parse(
        await readFile(path.join(runsDir, run as string, "report.json"), "utf8"),
      ) as EvalReport;
      expect(runReport.soundMode).toMatchObject({ sfxMode: "storyboard", filmReview: false });
      expect(runReport.sites[0]).toMatchObject({ review: null, sound: null });
      const md = await readFile(path.join(runsDir, run as string, "report.md"), "utf8");
      expect(md).toContain("Звук: storyboard, рецензія off.");
      expect(md).toContain("| 01-parity | — | — | — |");
      const caseReport = JSON.parse(
        await readFile(path.join(tmp, "out", "parity", "report.json"), "utf8"),
      ) as CaseReport;
      expect(caseReport).toMatchObject({
        soundMode: { sfxMode: "storyboard", filmReview: false },
        review: null,
        sound: null,
      });
      expect(lines.join("\n")).toContain("звук storyboard, рецензія off");

      process.env.ADC_SFX_MODE = "loud";
      const bad: string[] = [];
      const badCode = await runEvalCli(["--sites", sites, "--out", runsDir, "--case", "parity"], {
        anthropic: createMockAnthropic([]),
        print: (l) => bad.push(l),
      });
      expect(badCode).toBe(2);
      expect(bad.join("\n")).toContain("ADC_SFX_MODE=loud");
    } finally {
      restore();
    }
  });
});

// ───────────────────────────── Epidemic Sound ─────────────────────────────

describe("Epidemic у eval", () => {
  const sitesFile = async () => {
    const file = path.join(tmp, "sites.json");
    await writeFile(file, JSON.stringify([{ url: "https://parity.example.com/", name: "parity" }]));
    return file;
  };
  const failCrawl: Stage<"crawl"> = async () => {
    throw new StageError("заглушка", "stub_crawl", "Сайт недоступний (тест).", false);
  };

  it("невалідний ADC_MUSIC_PROVIDER — код 2 до перевірки ключів API", async () => {
    const sites = await sitesFile();
    const lines: string[] = [];
    const code = await withEnv(
      { ADC_MUSIC_PROVIDER: "suno", ANTHROPIC_API_KEY: undefined, ELEVENLABS_API_KEY: undefined },
      () => runEvalCli(["--sites", sites, "--out", path.join(tmp, "runs")], { print: (l) => lines.push(l) }),
    );
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("ADC_MUSIC_PROVIDER=suno");
    expect(lines.join("\n")).not.toContain("ANTHROPIC_API_KEY");
    expect(existsSync(path.join(tmp, "runs"))).toBe(false);
  });

  it("провайдер epidemic без EPIDEMIC_API_KEY — код 2 до старту", async () => {
    const sites = await sitesFile();
    for (const vars of [{ ADC_MUSIC_PROVIDER: "epidemic" }, { ADC_SFX_PROVIDER: "epidemic" }]) {
      const lines: string[] = [];
      const code = await withEnv({ ...vars, EPIDEMIC_API_KEY: undefined }, () =>
        runEvalCli(["--sites", sites, "--out", path.join(tmp, "runs")], {
          anthropic: createMockAnthropic([]),
          print: (l) => lines.push(l),
        }),
      );
      expect(code).toBe(2);
      expect(lines.join("\n")).toContain(
        "eval: ADC_*_PROVIDER=epidemic потребує EPIDEMIC_API_KEY у кореневому .env",
      );
    }
    expect(existsSync(path.join(tmp, "runs"))).toBe(false);
  });

  it("провайдери з env — у рядку старту, у звіті прогону й лічильник Epidemic з downloads.json", async () => {
    const sites = await sitesFile();
    const runsDir = path.join(tmp, "runs");
    const lines: string[] = [];
    await mkdir(path.join(tmp, "epidemic"), { recursive: true });
    await writeFile(
      path.join(tmp, "epidemic", "downloads.json"),
      JSON.stringify({ version: 1, used: 7, events: [] }),
    );
    const code = await withEnv(
      { ADC_MUSIC_PROVIDER: "epidemic", ADC_SFX_PROVIDER: "elevenlabs", EPIDEMIC_API_KEY: "epidemic_test_x" },
      () =>
        runEvalCli(["--sites", sites, "--out", runsDir, "--case", "parity"], {
          anthropic: createMockAnthropic([]),
          registry: createStageRegistry({ overrides: { crawl: failCrawl } }),
          print: (l) => lines.push(l),
        }),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("eval: провайдери music=epidemic, sfx=elevenlabs");
    expect(lines.join("\n")).toContain("Завантажень Epidemic за прогін: 0 (лічильник: 7 з 50)");
    const [run] = await readdir(runsDir);
    const runReport = JSON.parse(
      await readFile(path.join(runsDir, run as string, "report.json"), "utf8"),
    ) as EvalReport;
    expect(runReport.soundMode).toMatchObject({ musicProvider: "epidemic", sfxProvider: "elevenlabs" });
    expect(runReport.epidemicUsed).toBe(7);
    // Аудіо не дійшло — даних ревізії немає: дефолт elevenlabs і «—».
    expect(runReport.sites[0]?.audio).toEqual(NO_EPIDEMIC);
    const md = await readFile(path.join(runsDir, run as string, "report.md"), "utf8");
    expect(md).toContain("Завантажень Epidemic за прогін: 0 (лічильник: 7 з 50)");
  });

  it("readEpidemicUsed: немає файлу або він не за схемою — null", async () => {
    const dir = path.join(tmp, "epidemic");
    expect(await readEpidemicUsed(dir)).toBeNull();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "downloads.json"), JSON.stringify({ used: "багато" }));
    expect(await readEpidemicUsed(dir)).toBeNull();
    await writeFile(
      path.join(dir, "downloads.json"),
      JSON.stringify({
        version: 1,
        used: 12,
        events: [{ ts: "2026-10-19T00:00:00.000Z", kind: "sfx", id: "s1", detail: null }],
      }),
    );
    expect(await readEpidemicUsed(dir)).toBe(12);
  });

  it("prepareRerun(audio): audioPlanHash = null, провайдери в pipe і в параметрах job", async () => {
    const storage = new LocalStorage(tmp);
    await storage.writeJson(
      projectPaths("p1").project,
      fixtureProject({
        id: "p1",
        status: "delivered",
        brandkitVersion: 1,
        branches: { video: "done", audio: "done" },
        audioPlanHash: "old-plan",
      }),
    );
    const rev = projectPaths("p1").rev(1);
    await storage.writeJson(rev.storyboard, fixtureStoryboard);
    await storage.write(rev.scenesIndex, "export default {};\n");
    await storage.writeJson(
      rev.pipeline,
      PipeState.parse({ attempts: {}, fixRounds: {}, qaRounds: 0, templateScenes: [], dirtyScenes: [] }),
    );

    const [job] = await prepareRerun(storage, "p1", "audio", new Date(), "designer", {
      music: "elevenlabs",
      sfx: "epidemic",
    });
    expect(job).toMatchObject({
      stage: "audio",
      params: { phase: "music", musicProvider: "elevenlabs", sfxProvider: "epidemic" },
    });
    const project = await storage.readJson(projectPaths("p1").project, (v) => ProjectState.parse(v));
    expect(project.audioPlanHash).toBeNull();
    const pipe = await storage.readJson(rev.pipeline, (v) => PipeState.parse(v));
    expect(pipe).toMatchObject({ musicProvider: "elevenlabs", sfxProvider: "epidemic" });
    expect(pipe.outstanding[0]).toMatchObject({ params: { sfxProvider: "epidemic" } });

    // Дефолт — з env (currentSoundTuning); інші етапи теж фіксують провайдери в pipe.
    await withEnv({ ADC_MUSIC_PROVIDER: "epidemic", ADC_SFX_PROVIDER: undefined }, async () => {
      const [full] = await prepareRerun(storage, "p1", "audio", new Date(), "storyboard");
      expect(full).toMatchObject({
        params: { phase: "full", musicProvider: "epidemic", sfxProvider: "elevenlabs" },
      });
      await prepareRerun(storage, "p1", "qa", new Date(), "designer");
      expect(await storage.readJson(rev.pipeline, (v) => PipeState.parse(v))).toMatchObject({
        musicProvider: "epidemic",
        sfxProvider: "elevenlabs",
      });
    });
  });

  it("звіт: провайдери й Epidemic з audio.json і music.json; старі дані — elevenlabs і «—»", async () => {
    const storage = new LocalStorage(tmp);
    await storage.writeJson(projectPaths("p1").project, fixtureProject({ id: "p1", status: "delivered" }));
    const rev = projectPaths("p1").rev(1);
    // Старий audio.json без providers/epidemic.
    await storage.writeJson(rev.audio, { music: null, sfx: [], totalFrames: 450 });
    expect(await readSiteAudio(storage, "p1", 1)).toEqual(NO_EPIDEMIC);
    // Немає audio.json зовсім — так само.
    expect(await readSiteAudio(storage, "p2", 1)).toEqual(NO_EPIDEMIC);

    await storage.writeJson(rev.audio, {
      ...fixtureAudioManifest,
      music: { ...fixtureAudioManifest.music, planHash: "ph1" },
      providers: { music: "epidemic", sfx: "elevenlabs" },
      epidemic: { trackId: "T1", sfx: [], downloads: 2 },
    });
    await storage.writeJson(projectPaths("p1").musicMeta("ph1"), {
      planHash: "ph1",
      durationMs: 33_000,
      modelId: "epidemic",
      provider: "epidemic",
      method: "catalog",
      promptUsed: null,
      briefHash: "b",
      createdAt: "2026-10-19T00:00:00.000Z",
      epidemic: {
        trackId: "T1",
        title: "Neon Run",
        artists: ["A"],
        bpm: 128,
        targetBpm: 110,
        tempoWarning: true,
        versionJobId: null,
        versionStatus: "TIMEOUT",
        candidatesTried: 1,
      },
    });
    const site = await buildSiteReport(storage, "p1", { name: "01-p", since: new Date(0), wallSeconds: 1 });
    expect(site.audio).toEqual({
      musicProvider: "epidemic",
      sfxProvider: "elevenlabs",
      epidemic: {
        trackId: "T1",
        trackTitle: "Neon Run",
        sfxCount: 0,
        downloads: 2,
        tempoWarning: true,
        versionStatus: "TIMEOUT",
      },
    });

    const sfxSite = caseSite({
      name: "02-b",
      audio: {
        musicProvider: "elevenlabs",
        sfxProvider: "epidemic",
        epidemic: {
          trackId: null,
          trackTitle: null,
          sfxCount: 9,
          downloads: 9,
          tempoWarning: false,
          versionStatus: null,
        },
      },
    });
    const sites = [caseSite({ name: "01-p", audio: site.audio }), sfxSite, caseSite({ name: "03-old" })];
    const summary = summarize(sites);
    expect(summary.epidemicDownloads).toBe(11);
    const md = reportMarkdown({
      run: "r",
      startedAt: "2026-10-19T10:00:00.000Z",
      finishedAt: "2026-10-19T11:00:00.000Z",
      mode: "pipeline",
      soundMode: { sfxMode: "designer", filmReview: false, reviewMaxRounds: 1, ...ELEVEN },
      from: "audio",
      baseRun: "r0",
      only: false,
      sites,
      summary,
      epidemicUsed: null,
    });
    expect(md).toContain("| Музика | SFX | Epidemic: трек / семплів / завантажень |");
    expect(md).toContain("| epidemic | elevenlabs | Neon Run (T1) ⚠ темп ⚠ версія: TIMEOUT / 0 / 2 |");
    expect(md).toContain("| elevenlabs | epidemic | — / 9 / 9 |");
    expect(md).toMatch(/\| 03-old \|.*\| elevenlabs \| elevenlabs \| — \|/);
    expect(md).toContain("Завантажень Epidemic за прогін: 11 (лічильник: — з 50)");

    const caseReport = await buildCaseReport(storage, "p1", {
      caseName: "p",
      run: "r",
      since: new Date(0),
      site,
      mode: "pipeline",
      soundMode: { sfxMode: "designer", filmReview: false, reviewMaxRounds: 1, ...ELEVEN },
      decode,
    });
    expect(caseReport.providers).toEqual(site.audio);
    const caseMd = caseReportMarkdown(caseReport);
    expect(caseMd).toContain("| Музика | epidemic |");
    expect(caseMd).toContain("| SFX | elevenlabs |");
    expect(caseMd).toContain(
      "| Epidemic: трек / семплів / завантажень | Neon Run (T1) ⚠ темп ⚠ версія: TIMEOUT / 0 / 2 |",
    );
  });

  it("eval/sites.epidemic.json валідний: webreportio-parity і profitstore", async () => {
    const args = parseEvalArgs([]);
    const sites = await loadSites(path.join(path.dirname(args.sites), "sites.epidemic.json"));
    const parity = (await loadSites(args.sites)).find((s) => s.name === "webreportio-parity");
    expect(sites.map((s) => s.name)).toEqual(["webreportio-parity", "profitstore"]);
    expect(sites[0]).toEqual(parity);
    expect(sites[1]).toEqual({
      name: "profitstore",
      url: "https://profitstore.ua/",
      text: null,
      formats: ["landscape"],
      language: "uk",
      photos: [],
      durationSeconds: 25,
    });
  });
});
