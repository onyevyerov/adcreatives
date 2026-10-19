import { describe, expect, it } from "vitest";
import { createEpidemicClient } from "../src/epidemic/client.ts";
import { classifyEpidemicError } from "../src/epidemic/errors.ts";
import { EpidemicError } from "../src/provider.ts";

interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
  signal: AbortSignal | null;
}

type Responder = (req: Captured) => Response | Promise<Response>;

/** Ін'єктований fetch: журнал запитів і черга відповідей (жодного реального виклику Epidemic). */
function fakeFetch(...responders: Responder[]) {
  const requests: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Captured = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      signal: init?.signal ?? null,
    };
    requests.push(req);
    const next = responders.shift();
    if (!next) throw new Error("fakeFetch: немає відповіді в черзі");
    return next(req);
  }) as typeof fetch;
  const req = (i: number): Captured => {
    const r = requests[i];
    if (!r) throw new Error(`fakeFetch: немає запиту #${i}`);
    return r;
  };
  return { impl, requests, req };
}

const json =
  (value: unknown, status = 200): Responder =>
  () =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** Відповідь, що висить, поки сигнал запиту не скасують. */
const hang: Responder = (req) =>
  new Promise<Response>((_, reject) => {
    req.signal?.addEventListener("abort", () => reject(req.signal?.reason));
  });

const track = {
  id: "t1",
  title: "Sunny Day",
  mainArtists: ["Artist A"],
  bpm: 92,
  length: 154.2,
  moods: [{ id: "happy", name: "Happy" }],
  genres: [{ id: "pop", name: "Pop" }],
  hasVocals: false,
  extraField: "ignored",
};

const BASE_ENV = "EPIDEMIC_API_BASE";

describe("createEpidemicClient", () => {
  it("без ключа — EpidemicError unauthorized", () => {
    expect(() => createEpidemicClient("", fakeFetch().impl)).toThrow(EpidemicError);
    expect(() => createEpidemicClient("  ", fakeFetch().impl)).toThrow(
      expect.objectContaining({ kind: "unauthorized" }),
    );
  });

  it("searchTracks: база, Bearer, Accept, повторювані vocalType, bpm; зайві поля ігноруються", async () => {
    const f = fakeFetch(json({ tracks: [track], pagination: { page: 1 } }));
    const client = createEpidemicClient("epidemic_live_k", f.impl);
    const res = await client.searchTracks({
      term: "warm lo-fi",
      bpmMin: 84,
      bpmMax: 96,
      vocalType: ["NONE", "PRESENCE"],
      sort: "Relevance",
      limit: 20,
    });
    const req = f.req(0);
    expect(req.method).toBe("GET");
    expect(req.url.origin).toBe("https://api.epidemicsound.com");
    expect(req.url.pathname).toBe("/v0/tracks/search");
    expect(req.url.searchParams.get("term")).toBe("warm lo-fi");
    expect(req.url.searchParams.get("bpmMin")).toBe("84");
    expect(req.url.searchParams.get("bpmMax")).toBe("96");
    expect(req.url.searchParams.getAll("vocalType")).toEqual(["NONE", "PRESENCE"]);
    expect(req.url.searchParams.get("sort")).toBe("Relevance");
    expect(req.url.searchParams.get("limit")).toBe("20");
    expect(req.url.searchParams.has("offset")).toBe(false);
    expect(req.headers.get("authorization")).toBe("Bearer epidemic_live_k");
    expect(req.headers.get("accept")).toBe("application/json");
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(res.tracks).toEqual([
      {
        id: "t1",
        title: "Sunny Day",
        mainArtists: ["Artist A"],
        bpm: 92,
        length: 154.2,
        moods: [{ id: "happy", name: "Happy" }],
        genres: [{ id: "pop", name: "Pop" }],
        hasVocals: false,
      },
    ]);
  });

  it("searchTracks: толерантний до артистів-об'єктів і відсутніх необов'язкових полів", async () => {
    const f = fakeFetch(
      json({ tracks: [{ id: 7, title: "X", length: 60, mainArtists: [{ name: "B" }], bpm: null }] }),
    );
    const res = await createEpidemicClient("k", f.impl).searchTracks({ term: "x" });
    expect(res.tracks[0]).toEqual({
      id: "7",
      title: "X",
      mainArtists: ["B"],
      bpm: null,
      length: 60,
      moods: [],
      genres: [],
      hasVocals: false,
    });
  });

  it("searchSoundEffects: term, sort, limit; зайві поля семпла ігноруються", async () => {
    const f = fakeFetch(json({ soundEffects: [{ id: "s1", title: "Whoosh", length: 1.2, bpm: 0 }] }));
    const res = await createEpidemicClient("k", f.impl).searchSoundEffects({
      term: "whoosh",
      sort: "best-match",
      limit: 5,
    });
    expect(res.soundEffects).toEqual([{ id: "s1", title: "Whoosh", length: 1.2 }]);
    const url = f.req(0).url;
    expect(url.pathname).toBe("/v0/sound-effects/search");
    expect(url.searchParams.get("sort")).toBe("best-match");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("EPIDEMIC_API_BASE перевизначає базу", async () => {
    const prev = process.env[BASE_ENV];
    process.env[BASE_ENV] = "http://127.0.0.1:9999/proxy/";
    try {
      const f = fakeFetch(json({ soundEffects: [] }));
      await createEpidemicClient("k", f.impl).searchSoundEffects({ term: "whoosh" });
      expect(f.req(0).url.href).toBe("http://127.0.0.1:9999/proxy/v0/sound-effects/search?term=whoosh");
    } finally {
      if (prev === undefined) delete process.env[BASE_ENV];
      else process.env[BASE_ENV] = prev;
    }
  });

  it("download-URL треку і SFX, Create versions і статус", async () => {
    const f = fakeFetch(
      json({ url: "https://cdn/t1.mp3?sig=1", expires: "2026-10-20T00:00:00Z" }),
      json({ url: "https://cdn/s1.mp3?sig=2", expires: "2026-10-20T00:00:00Z" }),
      json({ jobId: "job-1", status: "PENDING" }),
      json({
        status: "COMPLETED",
        results: { highQualityUrl: "https://cdn/v.mp3", previewUrl: "https://cdn/p.mp3" },
      }),
      json({ status: "FAILED", results: null, message: "bad" }),
    );
    const client = createEpidemicClient("k", f.impl);
    expect(await client.trackDownloadUrl("t 1", { quality: "normal" })).toEqual({
      url: "https://cdn/t1.mp3?sig=1",
      expires: "2026-10-20T00:00:00Z",
    });
    expect(await client.soundEffectDownloadUrl("s1", { quality: "normal" })).toMatchObject({
      url: "https://cdn/s1.mp3?sig=2",
    });
    expect(await client.startVersion({ trackId: "t1", durationMs: 30_000 })).toEqual({
      jobId: "job-1",
      status: "PENDING",
    });
    expect(await client.versionStatus("job-1")).toEqual({
      status: "COMPLETED",
      results: { highQualityUrl: "https://cdn/v.mp3", previewUrl: "https://cdn/p.mp3" },
    });
    expect(await client.versionStatus("job-1")).toEqual({ status: "FAILED", results: null, message: "bad" });

    const [dl, sfx, start, status] = [f.req(0), f.req(1), f.req(2), f.req(3)];
    expect(dl.url.pathname).toBe("/v0/tracks/t%201/download");
    expect(dl.url.searchParams.get("format")).toBe("mp3");
    expect(dl.url.searchParams.get("quality")).toBe("normal");
    expect(sfx.url.pathname).toBe("/v0/sound-effects/s1/download");
    expect(sfx.url.searchParams.get("quality")).toBe("normal");
    expect(start.method).toBe("POST");
    expect(start.url.pathname).toBe("/v0/tracks/versions");
    expect(start.headers.get("content-type")).toBe("application/json");
    expect(start.headers.get("authorization")).toBe("Bearer k");
    expect(JSON.parse(String(start.body))).toEqual({ trackId: "t1", durationMs: 30_000 });
    expect(status.url.pathname).toBe("/v0/tracks/versions/job-1");
  });

  it("fetchBytes: GET підписаного URL без Authorization, повертає Buffer", async () => {
    const f = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const buf = await createEpidemicClient("k", f.impl).fetchBytes("https://cdn/x.mp3?sig=abc");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf]).toEqual([1, 2, 3]);
    expect(f.req(0).url.href).toBe("https://cdn/x.mp3?sig=abc");
    expect(f.req(0).headers.has("authorization")).toBe(false);
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [400, "other"],
  ] as const)("HTTP %i → %s", async (status, kind) => {
    const f = fakeFetch(json({ message: "nope" }, status));
    const err = await createEpidemicClient("k", f.impl)
      .searchTracks({ term: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EpidemicError);
    expect(err).toMatchObject({ kind, status });
    expect(classifyEpidemicError(err)).toEqual({ kind, status });
  });

  it("помилка fetchBytes (403 протухлого URL) теж класифікується", async () => {
    const f = fakeFetch(() => new Response("expired", { status: 403 }));
    await expect(createEpidemicClient("k", f.impl).fetchBytes("https://cdn/x")).rejects.toMatchObject({
      kind: "unauthorized",
      status: 403,
    });
  });

  it("TypeError мережі → network", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(createEpidemicClient("k", f.impl).searchSoundEffects({ term: "x" })).rejects.toMatchObject({
      kind: "network",
      status: null,
    });
  });

  it("скасування зовнішнім signal → aborted", async () => {
    const ctrl = new AbortController();
    const f = fakeFetch((req) => {
      const pending = hang(req);
      ctrl.abort();
      return pending;
    });
    await expect(
      createEpidemicClient("k", f.impl).searchTracks({ term: "x" }, { signal: ctrl.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("уже скасований signal → aborted без запиту", async () => {
    const f = fakeFetch();
    await expect(
      createEpidemicClient("k", f.impl).searchTracks({ term: "x" }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(f.requests).toHaveLength(0);
  });

  it("таймаут (timeoutMs) → network (тимчасова відмова, черга повторить)", async () => {
    const f = fakeFetch(hang);
    const err = await createEpidemicClient("k", f.impl)
      .searchTracks({ term: "x" }, { timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "network", status: null });
    expect((err as Error).message).toMatch(/таймаут/);
  });

  it("невалідна відповідь (немає потрібних полів) → EpidemicError other", async () => {
    const f = fakeFetch(json({ url: 5 }));
    await expect(
      createEpidemicClient("k", f.impl).trackDownloadUrl("t1", { quality: "high" }),
    ).rejects.toMatchObject({ kind: "other", status: 200 });
  });
});

describe("classifyEpidemicError", () => {
  it("EpidemicError → його kind/status; сирі помилки — за типом", () => {
    expect(classifyEpidemicError(new EpidemicError("quota", "q"))).toEqual({ kind: "quota", status: null });
    expect(classifyEpidemicError(new TypeError("fetch failed"))).toEqual({ kind: "network", status: null });
    expect(classifyEpidemicError(new DOMException("x", "AbortError"))).toEqual({
      kind: "aborted",
      status: null,
    });
    expect(classifyEpidemicError(new DOMException("x", "TimeoutError"))).toEqual({
      kind: "network",
      status: null,
    });
    expect(classifyEpidemicError(Object.assign(new Error("x"), { status: 429 }))).toEqual({
      kind: "rate_limited",
      status: 429,
    });
    expect(classifyEpidemicError(new Error("boom"))).toEqual({ kind: "other", status: null });
    expect(classifyEpidemicError("str")).toEqual({ kind: "other", status: null });
  });

  it("EpidemicError у cause теж знаходиться", () => {
    const inner = new EpidemicError("rate_limited", "429", 429);
    expect(classifyEpidemicError(new Error("wrap", { cause: inner }))).toEqual({
      kind: "rate_limited",
      status: 429,
    });
  });
});
