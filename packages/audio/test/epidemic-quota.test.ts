import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRepoRoot } from "@adc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEpidemicQuota, epidemicDir } from "../src/epidemic/quota.ts";
import { EPIDEMIC_DOWNLOADS_FILE, EpidemicDownloadsFile, EpidemicError } from "../src/provider.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "adc-epidemic-quota-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(used: number): Promise<void> {
  const file: EpidemicDownloadsFile = { version: 1, used, events: [] };
  await writeFile(path.join(dir, EPIDEMIC_DOWNLOADS_FILE), JSON.stringify(file));
}

async function readFileJson(): Promise<EpidemicDownloadsFile> {
  return EpidemicDownloadsFile.parse(
    JSON.parse(await readFile(path.join(dir, EPIDEMIC_DOWNLOADS_FILE), "utf8")),
  );
}

describe("epidemicDir", () => {
  it("ADC_EPIDEMIC_DIR має пріоритет (відносний — від кореня репо)", () => {
    const abs = path.resolve(os.tmpdir(), "epi");
    expect(epidemicDir({ ADC_EPIDEMIC_DIR: abs })).toBe(abs);
    expect(epidemicDir({ ADC_EPIDEMIC_DIR: "shared/epi" })).toBe(path.join(findRepoRoot(), "shared", "epi"));
  });

  it("дефолт — <корінь репо>/.data/epidemic і не залежить від DATA_DIR", () => {
    const expected = path.join(findRepoRoot(), ".data", "epidemic");
    expect(epidemicDir({})).toBe(expected);
    expect(epidemicDir({ DATA_DIR: path.join(os.tmpdir(), "eval-run-123") })).toBe(expected);
    expect(epidemicDir({ ADC_EPIDEMIC_DIR: "  ", DATA_DIR: "x" })).toBe(expected);
  });
});

describe("createEpidemicQuota", () => {
  it("без файлу — 0; consume створює теку і файл за схемою з журналом", async () => {
    const nested = path.join(dir, "a", "b");
    const quota = createEpidemicQuota(nested);
    expect(await quota.used()).toBe(0);
    expect(await quota.consume("sfx", "s1", "whoosh")).toBe(1);
    expect(await quota.consume("track", "t1")).toBe(2);
    const file = EpidemicDownloadsFile.parse(
      JSON.parse(await readFile(path.join(nested, EPIDEMIC_DOWNLOADS_FILE), "utf8")),
    );
    expect(file.used).toBe(2);
    expect(file.events.map((e) => [e.kind, e.id, e.detail])).toEqual([
      ["sfx", "s1", "whoosh"],
      ["track", "t1", null],
    ]);
    expect(Number.isNaN(Date.parse(file.events[0]?.ts ?? ""))).toBe(false);
  });

  it("44 → ok (стає 45); 45 → помилка quota без інкременту", async () => {
    await seed(44);
    const quota = createEpidemicQuota(dir);
    expect(await quota.consume("version", "t1", "30000ms")).toBe(45);
    const err = await quota.consume("sfx", "s2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EpidemicError);
    expect(err).toMatchObject({ kind: "quota", status: null });
    expect((err as Error).message).toBe(
      "Epidemic: витрачено 45 з 50 завантажень, поріг 45 — прогін зупинено",
    );
    expect(await quota.used()).toBe(45);
    const file = await readFileJson();
    expect(file.used).toBe(45);
    expect(file.events).toHaveLength(1);
  });

  it("понад поріг (напр. 47) — теж помилка з фактичним N", async () => {
    await seed(47);
    await expect(createEpidemicQuota(dir).consume("sfx", "s")).rejects.toThrow(
      "Epidemic: витрачено 47 з 50 завантажень, поріг 45 — прогін зупинено",
    );
  });

  it("файл переживає новий екземпляр; consume читає файл щоразу", async () => {
    const a = createEpidemicQuota(dir);
    await a.consume("sfx", "s1");
    await a.consume("sfx", "s2");
    const b = createEpidemicQuota(dir);
    expect(await b.used()).toBe(2);
    expect(await b.consume("track", "t1")).toBe(3);
    // Старий екземпляр бачить запис нового.
    expect(await a.used()).toBe(3);
    expect(await a.consume("sfx", "s3")).toBe(4);
  });

  it("атомарний запис: після записів у теці лише downloads.json (без .tmp)", async () => {
    const quota = createEpidemicQuota(dir);
    for (let i = 0; i < 5; i++) await quota.consume("sfx", `s${i}`);
    expect(await readdir(dir)).toEqual([EPIDEMIC_DOWNLOADS_FILE]);
  });

  it("послідовні виклики з одного процесу не губляться (Promise.all)", async () => {
    const quota = createEpidemicQuota(dir);
    await Promise.all([1, 2, 3, 4].map((i) => quota.consume("sfx", `s${i}`)));
    expect(await quota.used()).toBe(4);
    expect((await readFileJson()).events).toHaveLength(4);
  });

  it("зіпсований файл — помилка, а не тихе обнулення лічильника", async () => {
    await writeFile(path.join(dir, EPIDEMIC_DOWNLOADS_FILE), "{ not json");
    await expect(createEpidemicQuota(dir).used()).rejects.toThrow(/downloads\.json/);
  });

  it("EPIDEMIC_QUOTA_OVERRIDE не обходить поріг", async () => {
    await seed(45);
    const prev = process.env.EPIDEMIC_QUOTA_OVERRIDE;
    process.env.EPIDEMIC_QUOTA_OVERRIDE = "1";
    try {
      await expect(createEpidemicQuota(dir).consume("sfx", "s")).rejects.toMatchObject({ kind: "quota" });
    } finally {
      if (prev === undefined) delete process.env.EPIDEMIC_QUOTA_OVERRIDE;
      else process.env.EPIDEMIC_QUOTA_OVERRIDE = prev;
    }
  });
});
