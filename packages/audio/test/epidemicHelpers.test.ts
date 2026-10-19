import type { EventPlacement } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { createEpidemicClient } from "../src/epidemic/client.ts";
import { EpidemicDownloadsFile, EpidemicError } from "../src/provider.ts";
import { variantIndices } from "../src/variants.ts";
import { memoryQuota, mockEpidemic } from "./epidemicHelpers.ts";

describe("mockEpidemic", () => {
  it("віддає черги по методах, кидає Error із черги і пише журнал calls", async () => {
    const track = {
      id: "t1",
      title: "Track",
      mainArtists: ["A"],
      bpm: 90,
      length: 120,
      moods: [],
      genres: [],
      hasVocals: false,
    };
    const ep = mockEpidemic({
      searchTracks: [{ tracks: [track] }, new EpidemicError("rate_limited", "429", 429)],
      versionStatus: [
        { status: "PENDING" },
        (jobId: unknown) => ({ status: "FAILED", message: String(jobId) }),
      ],
    });
    await expect(ep.searchTracks({ term: "lofi", bpmMin: 84, bpmMax: 96 })).resolves.toEqual({
      tracks: [track],
    });
    await expect(ep.searchTracks({ term: "lofi" })).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
    });
    await expect(ep.searchTracks({ term: "lofi" })).resolves.toEqual({ tracks: [] });
    await expect(ep.versionStatus("j1")).resolves.toEqual({ status: "PENDING" });
    await expect(ep.versionStatus("j1")).resolves.toEqual({ status: "FAILED", message: "j1" });
    await expect(ep.versionStatus("j2")).resolves.toMatchObject({ status: "COMPLETED" });
    const bytes = await ep.fetchBytes("https://dl.example/x.mp3", { timeoutMs: 5 });
    expect(bytes.toString()).toBe("BYTES:https://dl.example/x.mp3");
    expect(ep.calls.map((c) => c.method)).toEqual([
      "searchTracks",
      "searchTracks",
      "searchTracks",
      "versionStatus",
      "versionStatus",
      "versionStatus",
      "fetchBytes",
    ]);
    expect(ep.calls[0]?.args[0]).toMatchObject({ bpmMin: 84 });
    expect(ep.calls.at(-1)?.options).toEqual({ timeoutMs: 5 });
  });
});

describe("memoryQuota", () => {
  it("рахує завантаження і зупиняє на порозі 45 без інкременту", async () => {
    const q = memoryQuota(43);
    expect(await q.consume("version", "t1")).toBe(44);
    expect(await q.consume("sfx", "s1", "whoosh.1")).toBe(45);
    await expect(q.consume("track", "t1")).rejects.toMatchObject({ kind: "quota" });
    expect(await q.used()).toBe(45);
    expect(q.consumed).toEqual([
      { kind: "version", id: "t1", detail: null },
      { kind: "sfx", id: "s1", detail: "whoosh.1" },
    ]);
  });
});

describe("заглушки Кроку 0", () => {
  it("клієнт без ключа — unauthorized", () => {
    expect(() => createEpidemicClient("")).toThrow(EpidemicError);
    expect(() => createEpidemicClient(undefined)).toThrow(expect.objectContaining({ kind: "unauthorized" }));
  });

  it("формат downloads.json", () => {
    const file = {
      version: 1,
      used: 1,
      events: [{ ts: "2026-10-19T00:00:00Z", kind: "sfx", id: "s1", detail: null }],
    };
    expect(EpidemicDownloadsFile.parse(file)).toEqual(file);
    expect(() => EpidemicDownloadsFile.parse({ ...file, version: 2 })).toThrow();
  });

  it("variantIndices: ротація по колу на cue, 1-based, без cue — пропуск", () => {
    const at = (sceneId: string, cue: EventPlacement["cue"]) => ({ sceneId, cue }) as EventPlacement;
    const placements = [
      at("s1", "whoosh"),
      at("s1", "pop"),
      at("s2", "whoosh"),
      at("s2", null),
      at("s3", "whoosh"),
    ];
    expect(variantIndices(placements, (cue) => (cue === "whoosh" ? 2 : 5))).toEqual([
      { cue: "whoosh", variant: 1 },
      { cue: "pop", variant: 1 },
      { cue: "whoosh", variant: 2 },
      { cue: "whoosh", variant: 1 },
    ]);
  });
});
