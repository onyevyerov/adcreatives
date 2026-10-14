import path from "node:path";
import {
  type BrandKitFile,
  type Logger,
  type LogMeta,
  noopLogger,
  projectPaths,
  revPaths,
} from "@adc/shared";
import { fixtureAudioManifest, fixtureBrandKitFile } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { parseFileBlocks, parseSingleScene, scenesIndexSource } from "../src/files.ts";
import { prepareJob, prepareRenderJob } from "../src/job.ts";
import { exampleSources, PROJECT_ID, seedProject, tmpStorage } from "./helpers.ts";

describe("prepareRenderJob", () => {
  it("MainProps з бренд-кіта, розкадровки, асетів і audio.json; реєстр без templateScenes", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const rp = revPaths(PROJECT_ID, 1);
    const ex = exampleSources();
    await storage.write(rp.scene("s1"), ex["hook-photo"]);
    await storage.write(rp.scene("s2"), ex["offer-price"]);
    await storage.writeJson(rp.audio, fixtureAudioManifest);

    const { jobDir, mainProps } = await prepareRenderJob({
      storage,
      projectId: PROJECT_ID,
      rev: 1,
      format: "square",
      templateScenes: ["s2"],
    });
    expect(jobDir).toBe(path.resolve(storage.absPath(rp.videoDir)));
    expect(mainProps.format).toBe("square");
    expect(mainProps.templateScenes).toEqual(["s2"]);
    expect(mainProps.audio).toEqual(fixtureAudioManifest);
    expect(mainProps.brand).not.toHaveProperty("version");
    expect(mainProps.storyboard.scenes).toHaveLength(3);
    expect(mainProps.assets).toEqual({
      a01: { src: "assets/a01.jpg", width: 1920, height: 1280, focal: { x: 0.5, y: 0.4 } },
      a02: { src: "assets/a02.svg", width: 320, height: 120, focal: { x: 0.5, y: 0.5 } },
    });
    expect(await storage.exists(rp.publicFile("assets/a02.svg"))).toBe(true);
    expect(await storage.readText(rp.scenesIndex)).toContain("export default { s1: S1 };");
  });
});

describe("prepareJob: локальні шрифти сайту", () => {
  const fontKey = (name: string) => `${projectPaths(PROJECT_ID).root}/crawl/fonts/${name}`;
  const localBrand = (): BrandKitFile => ({
    ...fixtureBrandKitFile,
    typography: {
      ...fixtureBrandKitFile.typography,
      heading: {
        family: "Zerno Display",
        weights: [400, 700],
        origin: "local",
        files: [
          { weight: 400, style: "normal", format: "woff2", path: fontKey("zerno-display-400.woff2") },
          { weight: 700, style: "normal", format: "woff2", path: fontKey("zerno-display-700.woff2") },
        ],
      },
    },
  });

  function captureLogger(): { logger: Logger; warns: { msg: string; meta?: LogMeta }[] } {
    const warns: { msg: string; meta?: LogMeta }[] = [];
    return { logger: { ...noopLogger, warn: (msg, meta) => warns.push({ msg, meta }) }, warns };
  }

  it("копіює files[].path ролі з origin local у public/fonts/<basename>, наявні не перезаписує", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const rp = revPaths(PROJECT_ID, 1);
    await storage.write(fontKey("zerno-display-400.woff2"), "w400");
    await storage.write(fontKey("zerno-display-700.woff2"), "w700");
    // Уже скопійований раніше файл лишається як є.
    await storage.write(rp.publicFile("fonts/zerno-display-700.woff2"), "old");
    const { logger, warns } = captureLogger();

    const job = await prepareJob({ storage, projectId: PROJECT_ID, rev: 1, brandFile: localBrand(), logger });
    expect(await storage.readText(rp.publicFile("fonts/zerno-display-400.woff2"))).toBe("w400");
    expect(await storage.readText(rp.publicFile("fonts/zerno-display-700.woff2"))).toBe("old");
    expect(job.written).toContain(rp.publicFile("fonts/zerno-display-400.woff2"));
    expect(job.written).not.toContain(rp.publicFile("fonts/zerno-display-700.woff2"));
    expect(job.brand.typography.heading.files.map((f) => f.weight)).toEqual([400, 700]);
    expect(warns).toEqual([]);
  });

  it("шлях відносно теки проєкту теж знаходиться", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const rp = revPaths(PROJECT_ID, 1);
    await storage.write(fontKey("zerno-display-400.woff2"), "w400");
    const brandFile = localBrand();
    brandFile.typography.heading.files = [
      { weight: 400, style: "normal", format: "woff2", path: "crawl/fonts/zerno-display-400.woff2" },
    ];
    const job = await prepareJob({ storage, projectId: PROJECT_ID, rev: 1, brandFile, logger: noopLogger });
    expect(await storage.readText(rp.publicFile("fonts/zerno-display-400.woff2"))).toBe("w400");
    expect(job.brand.typography.heading.files).toHaveLength(1);
  });

  it("відсутній у сховищі файл — попередження і викидається з бренд-кіта (резервний стек)", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const rp = revPaths(PROJECT_ID, 1);
    await storage.write(fontKey("zerno-display-400.woff2"), "w400");
    const { logger, warns } = captureLogger();

    const job = await prepareJob({ storage, projectId: PROJECT_ID, rev: 1, brandFile: localBrand(), logger });
    expect(job.brand.typography.heading.files.map((f) => f.weight)).toEqual([400]);
    expect(job.brand.typography.body).toEqual(fixtureBrandKitFile.typography.body);
    expect(await storage.exists(rp.publicFile("fonts/zerno-display-700.woff2"))).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.meta).toMatchObject({
      family: "Zerno Display",
      path: fontKey("zerno-display-700.woff2"),
    });
  });

  it("бренд без локальних шрифтів — той самий бренд-кіт, нічого не копіюється", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const job = await prepareJob({ storage, projectId: PROJECT_ID, rev: 1, logger: noopLogger });
    expect(job.brand.typography).toEqual(fixtureBrandKitFile.typography);
    expect(job.written.some((k) => k.includes("/fonts/"))).toBe(false);
  });
});

describe("files", () => {
  it("розбирає <file>-блоки, огорожі й шляхи", () => {
    const text = [
      "Пояснення",
      '<file name="s1.tsx">\n```tsx\nexport default function Scene() { return null; }\n```\n</file>',
      "<file path='scenes/s2.tsx'>\nconst a = 1;\n</file>",
      '<file name="helper.ts">x</file>',
    ].join("\n");
    const files = parseFileBlocks(text);
    expect(files.map((f) => [f.name, f.sceneId])).toEqual([
      ["s1.tsx", "s1"],
      ["scenes/s2.tsx", "s2"],
      ["helper.ts", null],
    ]);
    expect(files[0]?.code).toBe("export default function Scene() { return null; }\n");
    expect(parseSingleScene("Ось:\n```tsx\nconst x = 1;\n```\n", "s5")).toBe("const x = 1;\n");
    expect(parseSingleScene("нічого", "s5")).toBeNull();
  });

  it("реєстр сцен у форматі хоста", () => {
    expect(scenesIndexSource(["s1", "s10", "bad"])).toContain(
      'import S10 from "./s10.tsx";\n\nexport default { s1: S1, s10: S10 };',
    );
  });
});
