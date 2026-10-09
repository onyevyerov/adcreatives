import path from "node:path";
import type { ChatEvent } from "@adc/shared";
import { fixtureBrandKitFile, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { formatEvent, parseRunArgs, runCli } from "../src/cli.ts";

const AT = "2026-10-06T00:00:00.000Z";
const root = path.join("D:", "data");

describe("cli: аргументи", () => {
  it("run: URL, фото, формати, авто, джерело", () => {
    const args = parseRunArgs([
      "https://zerno.example.com/",
      "--photo",
      "a.heic",
      "--formats",
      "9:16,16:9",
      "--auto",
    ]);
    expect(args).toMatchObject({
      url: "https://zerno.example.com/",
      formats: ["vertical", "landscape"],
      auto: true,
      source: "test",
    });
    expect(args.photos).toEqual([path.resolve("a.heic")]);
    expect(parseRunArgs(["--text", "Шиномонтаж", "--source", "chat"])).toMatchObject({
      url: null,
      text: "Шиномонтаж",
      source: "chat",
    });
  });

  it("помилки аргументів — код 2 і підказка, без запуску пайплайна", async () => {
    expect(() => parseRunArgs([])).toThrow(/URL/);
    expect(() => parseRunArgs(["https://a.example.com", "--formats", "4:5"])).toThrow(/4:5/);
    const out: string[] = [];
    expect(await runCli(["run", "--bogus"], (l) => out.push(l))).toBe(2);
    expect(out.join("\n")).toContain("Використання");
    expect(await runCli(["help"], (l) => out.push(l))).toBe(0);
  });
});

describe("cli: події чату в терміналі", () => {
  it("чекпоінти показують головне, шляхи — у DATA_DIR", () => {
    const brand = formatEvent(
      {
        type: "checkpoint",
        at: AT,
        rev: 1,
        checkpoint: "brand",
        payload: {
          checkpoint: "brand",
          brandkit: fixtureBrandKitFile,
          logoCandidates: [{ assetId: "a02", url: "/files/projects/p1/crawl/assets/a02.svg" }],
          photos: [],
          formats: ["vertical"],
          languageOptions: [],
          needMorePhotos: true,
        },
      },
      root,
    );
    expect(brand).toContain("Чекпоінт 1 — бренд: Зерно");
    expect(brand).toContain(path.join(root, "projects", "p1", "crawl", "assets", "a02.svg"));
    expect(brand).toContain("Придатних фото мало");

    const script = formatEvent(
      {
        type: "checkpoint",
        at: AT,
        rev: 1,
        checkpoint: "script",
        payload: {
          checkpoint: "script",
          storyboard: fixtureStoryboard,
          claims: {
            checkedAt: AT,
            brandkitVersion: 1,
            verified: [],
            unverified: [
              {
                sceneId: "s2",
                field: "sub",
                itemId: null,
                text: "-10%",
                kind: "percent",
                factId: null,
                matchedContact: false,
                matchedSite: false,
              },
            ],
          },
          thumbnails: [],
          musicBrief: fixtureStoryboard.musicBrief,
          durationSeconds: 15,
        },
      } as ChatEvent,
      root,
    );
    expect(script).toContain("s2 [offer] Капучино — 75 грн");
    expect(script).toContain("«-10%» — немає на сайті");
  });

  it("репліки клієнта не дублюються, витрати — з двома знаками", () => {
    expect(formatEvent({ type: "message", at: AT, role: "user", text: "привіт" }, root)).toBeNull();
    expect(
      formatEvent({ type: "cost", at: AT, totalUsd: 1.234, stage: "codegen", stageUsd: 0.5 }, root),
    ).toBe("$ Витрачено: $1.23 (codegen: $0.500)");
  });
});
