import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  LocalStorage,
  loadPrices,
  ProjectState,
  projectPaths,
  readTuning,
  type SoundCue,
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
  type CaseReport,
  caseReportMarkdown,
  type EvalReport,
  loadSites,
  measureAudioFile,
  measureCaseAudio,
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
      mode: "pipeline",
      from: null,
      baseRun: null,
      only: false,
      sites,
      summary: summarize(sites),
    };
    const md = reportMarkdown(report);
    expect(md).toContain("# Eval 2026-10-06-1530");
    expect(md).toContain("Режим генерації: pipeline.");
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
  usd: 1.5,
  usdByStage: [{ key: "codegen", usd: 1.5 }],
  usdByProvider: [{ key: "anthropic", usd: 1.5 }],
  llmCalls: 1,
  wallSeconds: 600,
  machineSeconds: 300,
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
});
