import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCostRecorder, createPromptLoader, loadPrices, readCosts, sharedPaths } from "@adc/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElevenLabsLike } from "../src/client.ts";
import { loadSfxLibrary, SFX_QC_MAX_RETRIES, SfxCacheMeta, sfxHash } from "../src/sfx.ts";
import {
  formatSfxQcTable,
  recheckSfxCache,
  regenerateFailedSfx,
  runSfxCacheCli,
  warmSfxCache,
} from "../src/sfxCache.ts";
import type { SfxQc, SfxQcHook } from "../src/sfxQc.ts";
import { instantGate, tmpStorage } from "./helpers.ts";

const prompts = createPromptLoader();
const library = loadSfxLibrary(prompts);

const sharedCost = (storage: ReturnType<typeof tmpStorage>) =>
  createCostRecorder(storage, loadPrices(), {
    projectId: null,
    rev: null,
    stage: "sfx-cache",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });

/** Мок SFX: вміст «аудіо» — `<версія>:<текст>`; версію тест міняє між прогонами. */
function versionedClient() {
  const state = { version: "v1", calls: 0 };
  const client: ElevenLabsLike = {
    music: {
      compose: async () => {
        throw new Error("не музика");
      },
      composeDetailed: async () => {
        throw new Error("не музика");
      },
    },
    textToSoundEffects: {
      convert: async (req) => {
        state.calls++;
        return Buffer.from(`${state.version}:${req.text}`);
      },
    },
  };
  return Object.assign(state, { client });
}

const qcOf = (ok: boolean, reasons: string[] = []): SfxQc => ({
  ok,
  peakDb: ok ? -3 : -30,
  onsetMs: 5,
  correlation: 1,
  pitchHz: null,
  reasons,
  attempts: 1,
});

/** Хук: провал для міток з `failing` (якщо задано `onlyVersion` — лише для файлів цієї версії). */
const hookFailing =
  (failing: readonly string[], onlyVersion?: string): SfxQcHook =>
  async (audio, cue) => {
    const bad = failing.includes(cue) && (!onlyVersion || audio.toString().startsWith(`${onlyVersion}:`));
    return bad ? qcOf(false, ["пік -30 dBFS < -12"]) : qcOf(true);
  };

const metaOf = (storage: ReturnType<typeof tmpStorage>, def: { text: string; durationSeconds: number }) =>
  storage.readJson(sharedPaths.sfxCacheMeta(sfxHash(def)), (v) => SfxCacheMeta.parse(v));

const ding2 = library.ding[1] as (typeof library.ding)[number];

describe("warmSfxCache: таблиця QC", () => {
  it("друкує по рядку на варіант із QC, спробами й причинами; підсумок унизу", async () => {
    const storage = tmpStorage();
    const mock = versionedClient();
    const lines: string[] = [];
    await warmSfxCache({
      storage,
      prompts,
      client: () => mock.client,
      gate: instantGate(),
      cost: sharedCost(storage),
      qc: hookFailing(["pop.2"]),
      print: (l) => lines.push(l),
    });
    // pop.2 не пройшов жодного разу: 1 + 2 повтори.
    expect(mock.calls).toBe(30 + SFX_QC_MAX_RETRIES);
    expect(lines).toHaveLength(1 + 30 + 1);
    expect(lines[0]).toMatch(/^cue\s+hash\s+стан\s+QC\s+спроб/);
    const pop2 = lines.find((l) => l.startsWith("pop.2 "));
    expect(pop2).toMatch(/згенеровано\s+✗\s+3\s+-30\s+5\s+1\s+—\s+пік -30 dBFS < -12$/);
    expect(lines.find((l) => l.startsWith("pop.1 "))).toMatch(/згенеровано\s+ok\s+1\s/);
    expect(lines.at(-1)).toBe("QC: 30 семплів, не пройшли 1, немає в кеші 0, QC не вдався 0");
    expect((await metaOf(storage, library.pop[1] as (typeof library.pop)[number])).qc).toMatchObject({
      ok: false,
      attempts: 3,
    });

    // Другий прогін — з кешу, таблиця бере QC з метаданих.
    lines.length = 0;
    await warmSfxCache({
      storage,
      prompts,
      client: () => mock.client,
      gate: instantGate(),
      cost: sharedCost(storage),
      print: (l) => lines.push(l),
    });
    expect(mock.calls).toBe(32);
    expect(lines.find((l) => l.startsWith("pop.2 "))).toMatch(/у кеші\s+✗\s+3/);
  });

  it("формат: без QC — прочерки, помилка QC — окремо, сортування за cue і номером", () => {
    const lines = formatSfxQcTable([
      { label: "pop.10", hash: "h3", key: "k", status: "cached", qc: null, error: null },
      { label: "pop.2", hash: "h2", key: null, status: "missing", qc: null, error: null },
      { label: "click.1", hash: "h1", key: "k", status: "cached", qc: null, error: "DecodeError: x" },
    ]);
    expect(lines.slice(1, 4).map((l) => l.split(/\s+/)[0])).toEqual(["click.1", "pop.2", "pop.10"]);
    expect(lines[1]).toMatch(/помилка.*DecodeError: x$/);
    expect(lines[2]).toMatch(/немає\s+—\s+—/);
    expect(lines.at(-1)).toBe("QC: 3 семплів, не пройшли 0, немає в кеші 1, QC не вдався 1");
  });
});

describe("recheckSfxCache", () => {
  it("переганяє QC по наявному кешу без платних викликів і оновлює qc у <hash>.json", async () => {
    const storage = tmpStorage();
    const mock = versionedClient();
    await warmSfxCache({
      storage,
      prompts,
      client: () => mock.client,
      gate: instantGate(),
      cost: sharedCost(storage),
      qc: hookFailing(["ding.1"]),
    });
    expect(mock.calls).toBe(32);

    // Нові пороги: тепер не проходять ding.2 і ding.3; ding.1 — проходить; QC click.1 падає.
    const hook: SfxQcHook = async (audio, cue, def, signal) => {
      if (cue === "click.1") throw new Error("ffmpeg не знайдено");
      return hookFailing(["ding.2", "ding.3"])(audio, cue, def, signal);
    };
    const rows = await recheckSfxCache({ storage, prompts, qc: hook });
    expect(mock.calls).toBe(32);
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.status === "cached")).toBe(true);
    expect(
      rows
        .filter((r) => r.qc && !r.qc.ok)
        .map((r) => r.label)
        .sort(),
    ).toEqual(["ding.2", "ding.3"]);
    const click = rows.find((r) => r.label === "click.1");
    expect(click?.error).toMatch(/ffmpeg/);
    expect(click?.qc).toMatchObject({ ok: true });

    // Спроби лишаються з генерації; qc перераховано.
    expect((await metaOf(storage, library.ding[0] as typeof ding2)).qc).toMatchObject({
      ok: true,
      attempts: 3,
    });
    expect((await metaOf(storage, ding2)).qc).toMatchObject({ ok: false, attempts: 1 });
    expect(await readCosts(storage, null)).toHaveLength(32);
  });

  it("немає в кеші — рядок missing; файл без метаданих отримує метадані з QC", async () => {
    const storage = tmpStorage();
    const key = sharedPaths.sfxCache(sfxHash(ding2));
    await storage.write(key, "v1:ding");
    const rows = await recheckSfxCache({ storage, prompts, qc: hookFailing([]) });
    expect(rows.filter((r) => r.status === "missing")).toHaveLength(29);
    expect(rows.find((r) => r.label === "ding.2")).toMatchObject({ status: "cached", key, qc: { ok: true } });
    expect(await metaOf(storage, ding2)).toMatchObject({
      cue: "ding.2",
      text: ding2.text,
      qc: { ok: true, attempts: 1 },
    });
  });
});

describe("regenerateFailedSfx", () => {
  it("переносить ті, що не пройшли, у rejected/ і генерує заново з QC; решта не чіпається", async () => {
    const storage = tmpStorage();
    const mock = versionedClient();
    const qc = hookFailing(["ding.2"], "v1");
    const base = {
      storage,
      prompts,
      client: () => mock.client,
      gate: instantGate(),
      cost: sharedCost(storage),
    };
    await warmSfxCache({ ...base, qc: async () => qcOf(true) });
    expect(mock.calls).toBe(30);

    mock.version = "v2";
    const { rejected, files } = await regenerateFailedSfx({
      ...base,
      qc,
      now: () => new Date("2026-10-13T10:00:00.000Z"),
    });
    expect(rejected.map((r) => r.label)).toEqual(["ding.2"]);
    expect(mock.calls).toBe(31);
    expect(files.filter((f) => f.generated).map((f) => f.cue)).toEqual(["ding.2"]);
    const key = sharedPaths.sfxCache(sfxHash(ding2));
    expect((await storage.read(key)).toString()).toBe(`v2:${ding2.text}`);
    expect((await metaOf(storage, ding2)).qc).toMatchObject({ ok: true, attempts: 1 });
    const pop1 = library.pop[0] as typeof ding2;
    expect((await storage.read(sharedPaths.sfxCache(sfxHash(pop1)))).toString()).toBe(`v1:${pop1.text}`);

    const rejectedDir = path.join(
      storage.absPath(sharedPaths.sfxCacheDir),
      "rejected",
      "2026-10-13T10-00-00-000Z",
    );
    expect(readdirSync(rejectedDir).sort()).toEqual(
      [`${sfxHash(ding2)}.json`, path.basename(rejected[0]?.key as string)].sort(),
    );
    // Після перегенерації кеш проходить QC (відбраковане з rejected/ не перевіряється).
    expect((await recheckSfxCache({ storage, prompts, qc })).filter((r) => r.qc && !r.qc.ok)).toEqual([]);
    expect(await readCosts(storage, null)).toHaveLength(31);
  });
});

describe("CLI pnpm sfx-cache", () => {
  const saved = { LIVE: process.env.LIVE, DATA_DIR: process.env.DATA_DIR };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });
  const cli = async (argv: string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), "adc-sfx-cli-"));
    // "0", а не delete: loadRootEnv не перезаписує наявні змінні, тож LIVE=1 з .env не підхопиться.
    process.env.LIVE = "0";
    process.env.DATA_DIR = dir;
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const code = await runSfxCacheCli(argv);
    return { code, out, dir };
  };

  it("--regenerate-failed без LIVE=1 відмовляє і нічого не чіпає", async () => {
    const { code, out, dir } = await cli(["--regenerate-failed"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/платна і вимкнена.*LIVE=1 pnpm sfx-cache --regenerate-failed/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("--recheck безкоштовний: працює без LIVE і без ключа, друкує таблицю", async () => {
    const key = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const { code, out } = await cli(["--recheck"]);
      expect(code).toBe(0);
      expect(out[0]).toMatch(/^cue\s+hash/);
      expect(out.at(-1)).toBe("QC: 30 семплів, не пройшли 0, немає в кеші 30, QC не вдався 0");
    } finally {
      if (key !== undefined) process.env.ELEVENLABS_API_KEY = key;
    }
  });

  it("невідомий прапорець або обидва режими разом — помилка", async () => {
    expect((await cli(["--regenerate"])).code).toBe(1);
    expect((await cli(["--recheck", "--regenerate-failed"])).code).toBe(1);
  });
});
