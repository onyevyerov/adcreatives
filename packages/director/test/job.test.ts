import path from "node:path";
import { revPaths } from "@adc/shared";
import { fixtureAudioManifest } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { parseFileBlocks, parseSingleScene, scenesIndexSource } from "../src/files.ts";
import { prepareRenderJob } from "../src/job.ts";
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
