import { compareStreamIds as sharedCompare } from "@adc/shared";
import { describe, expect, it } from "vitest";
import {
  eventsOf,
  PATHS,
  PROJECT_ID,
  SITE_HOST,
  type StoredEvent,
  segments,
  storyboardPayload,
} from "../../public/static/dev/fixture-events.js";
import { fixtureStates, fold } from "../../public/static/dev/fixture-states.js";
import type { ChatEvent, UiState } from "../../public/static/js/contracts.js";
import { compareStreamIds, createEventGate, reduce, reduceAll } from "../../public/static/js/data/reduce.js";
import { initialState } from "../../public/static/js/initial.js";

/** Та сама база, що в fixture-states.fold. */
const base = (): UiState => ({ ...initialState("project", PROJECT_ID), site: SITE_HOST, conn: "online" });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const at = (sec: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, sec)).toISOString();
let n = 0;
const ev = (event: Record<string, unknown>, sec = 0): StoredEvent => ({
  id: `${1_000 + ++n}-0`,
  event: { at: at(sec), ...event } as ChatEvent,
});
const stateEv = (status: string, prev: string | null, sec: number, rev = 1) =>
  ev({ type: "state", status, prev, rev }, sec);
const progressEv = (stage: string, label: string, done: number | null = null, total: number | null = null) =>
  ev({ type: "progress", stage, label, done, total });

describe("reduce: фікстура «Зерна»", () => {
  it.each(Object.keys(PATHS) as (keyof typeof PATHS)[])("шлях %s: кожен префікс = fold()", (name) => {
    const events = eventsOf(PATHS[name]);
    let s = base();
    for (let i = 0; i < events.length; i++) {
      const e = events[i] as StoredEvent;
      s = reduce(s, e.event, e.id);
      expect(s, `${name} #${i} ${e.id} ${e.event.type}`).toEqual(fold(events.slice(0, i + 1)));
    }
  });

  it("повний шлях збігається з fixtureStates", () => {
    const pairs: [string, keyof typeof PATHS][] = [
      ["awaitingBrand", "brand"],
      ["awaitingScript", "script"],
      ["awaitingStoryboard", "storyboard"],
      ["delivered", "delivered"],
      ["failed", "failed"],
      ["deliveredRev2", "revisionDelivered"],
    ];
    for (const [state, path] of pairs) {
      expect(reduceAll(base(), eventsOf(PATHS[path])), state).toEqual(fixtureStates[state]);
    }
  });

  it("ключові поля в кожній точці", () => {
    const brand = reduceAll(base(), eventsOf(PATHS.brand));
    expect(brand.status).toBe("awaiting_brand");
    expect(brand.checkpoints.brand).toMatchObject({ rev: 1, state: "open" });
    expect(brand.checkpoints.brand?.payload.checkpoint).toBe("brand");
    expect(brand.feed.at(-1)).toMatchObject({ kind: "checkpoint", checkpoint: "brand", rev: 1 });
    expect(brand.feed.some((i) => i.kind === "progress" && i.running)).toBe(false);
    expect(brand.stageLog).toEqual([]);
    expect(brand.progress).toBeNull();
    expect(brand.totalUsd).toBeCloseTo(0.33);

    const script = reduceAll(base(), eventsOf(PATHS.script));
    expect(script.checkpoints.brand?.state).toBe("approved");
    expect(script.checkpoints.script?.state).toBe("open");
    expect(
      script.feed.filter((i) => i.kind === "message" && i.role === "user").map((i) => i.id),
    ).toHaveLength(2);

    const delivered = reduceAll(base(), eventsOf(PATHS.delivered));
    expect(delivered.status).toBe("delivered");
    expect(delivered.prevStatus).toBe("rendering");
    expect(delivered.checkpoints.storyboard?.state).toBe("approved");
    expect(delivered.artifacts.videos.map((v) => [v.format, v.rev])).toEqual([
      ["vertical", 1],
      ["square", 1],
    ]);
    expect(delivered.artifacts.poster).toContain("poster.svg");
    expect(delivered.breakdown?.map((b) => b.stage)).toContain("codegen");
    expect(delivered.busySince).toBeNull();

    const failed = reduceAll(base(), eventsOf(PATHS.failed));
    expect(failed.error).toEqual({
      stage: "codegen",
      message: "модель не відповіла вчасно.",
      retryable: true,
    });
    expect(failed.feed.some((i) => i.kind === "error")).toBe(true);
    const retried = reduceAll(failed, segments.retry);
    expect(retried.error).toBeNull();
    expect(retried.status).toBe("awaiting_storyboard");

    const rev2 = reduceAll(base(), eventsOf(PATHS.revisionDelivered));
    expect(rev2.rev).toBe(2);
    expect(rev2.artifacts.videos.map((v) => `${v.format}@${v.rev}`)).toEqual([
      "vertical@1",
      "square@1",
      "vertical@2",
      "square@2",
    ]);
    expect(rev2.checkpoints.storyboard).toMatchObject({ rev: 2, state: "approved" });
  });

  it("stageLog — мітки поточного busy-стану без повторів підряд", () => {
    const events = segments.toBrand;
    const i = events.findIndex((e) => e.event.type === "cost");
    const s = reduceAll(base(), events.slice(0, i));
    expect(s.status).toBe("crawling");
    expect(s.stageLog.map((l) => l.label)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((k) => `Сканую сайт… ${k}/7 сторінок`),
    );
    expect(s.progress).toEqual({ stage: "crawl", label: "Сканую сайт… 7/7 сторінок", done: 7, total: 7 });
    // Один рядок progress у стрічці на всі 7 оновлень.
    expect(s.feed.filter((f) => f.kind === "progress")).toHaveLength(1);
  });
});

describe("reduce: правила", () => {
  it("чиста: не мутує вхідний стан", () => {
    let s = deepFreeze(base());
    for (const e of eventsOf(PATHS.revisionDelivered)) s = deepFreeze(reduce(s, e.event, e.id));
    expect(s.status).toBe("delivered");
  });

  it("ідемпотентна: повтор кожної події одразу нічого не змінює", () => {
    let s = base();
    for (const e of eventsOf(PATHS.revisionDelivered)) {
      s = reduce(s, e.event, e.id);
      expect(reduce(s, e.event, e.id), `${e.id} ${e.event.type}`).toEqual(s);
    }
  });

  it("події стрічки з уже відомим id ігноруються навіть пізніше", () => {
    const events = eventsOf(PATHS.script);
    const s = reduceAll(base(), events);
    const replay = events.filter((e) => ["message", "checkpoint", "error"].includes(e.event.type));
    expect(reduceAll(s, replay)).toBe(s);
  });

  it("ворота: повтор і старі ID стріму відкидаються", () => {
    const gate = createEventGate();
    const events = eventsOf(PATHS.delivered);
    const accepted = [...events, ...events.slice(10), ...events].filter((e) => gate.accept(e.id));
    expect(accepted).toEqual(events);
    expect(gate.last).toBe(events.at(-1)?.id);
    expect(createEventGate("5-0").accept("4-9")).toBe(false);
    expect(createEventGate("5-0").accept("5-1")).toBe(true);
    // Не-стрімові ID (mock) пропускаються — їх дедуплікує reduce.
    const g = createEventGate("5-0");
    expect(g.accept("mock-1")).toBe(true);
    expect(g.last).toBe("5-0");
  });

  it("compareStreamIds = @adc/shared", () => {
    const ids = ["0-0", "1-0", "1-1", "1-10", "2-0", "10-0", "1759744800000-0", "1759744800000-3"];
    for (const a of ids)
      for (const b of ids) expect(Math.sign(compareStreamIds(a, b))).toBe(Math.sign(sharedCompare(a, b)));
  });

  it("busyMs/busySince рахуються за `at` state-подій", () => {
    let s = base();
    s = reduceAll(s, [stateEv("crawling", "intake", 0)]);
    expect(s.busySince).toBe(at(0));
    s = reduceAll(s, [stateEv("brandkit", "crawling", 10)]);
    expect(s.busySince).toBe(at(0));
    s = reduceAll(s, [stateEv("awaiting_brand", "brandkit", 25)]);
    expect(s.busyMs).toBe(25_000);
    expect(s.busySince).toBeNull();
    s = reduceAll(s, [stateEv("scripting", "awaiting_brand", 40)]);
    expect(s.busySince).toBe(at(40));
    s = reduceAll(s, [stateEv("failed", "scripting", 45)]);
    expect(s.busyMs).toBe(30_000);
    expect(s.busySince).toBeNull();
  });

  it("busyMs фікстури «готово» = сума busy-відрізків", () => {
    const events = eventsOf(PATHS.delivered);
    let expected = 0;
    let since: number | null = null;
    const busy = ["crawling", "brandkit", "scripting", "directing", "rendering", "revising"];
    for (const { event } of events) {
      if (event.type !== "state") continue;
      const t = Date.parse(event.at);
      if (busy.includes(event.status)) since ??= t;
      else if (since !== null) {
        expected += t - since;
        since = null;
      }
    }
    expect(reduceAll(base(), events).busyMs).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("progress: той самий stage оновлює рядок, інший — закриває і додає новий", () => {
    let s = reduceAll(base(), [stateEv("directing", "awaiting_script", 0)]);
    const a = progressEv("codegen", "Генерую… 0/3", 0, 3);
    const b = progressEv("codegen", "Генерую… 1/3", 1, 3);
    const c = progressEv("audio", "Пишу музику…");
    s = reduceAll(s, [a, b]);
    expect(s.feed).toEqual([
      expect.objectContaining({ kind: "progress", id: a.id, label: "Генерую… 1/3", done: 1, running: true }),
    ]);
    s = reduceAll(s, [c]);
    expect(s.feed.map((f) => [f.id, f.kind === "progress" && f.running])).toEqual([
      [a.id, false],
      [c.id, true],
    ]);
    expect(s.stageLog).toEqual([
      { stage: "codegen", label: "Генерую… 0/3" },
      { stage: "codegen", label: "Генерую… 1/3" },
      { stage: "audio", label: "Пишу музику…" },
    ]);
    // Зміна статусу закриває рядки і скидає журнал етапу.
    s = reduceAll(s, [stateEv("awaiting_storyboard", "directing", 30)]);
    expect(s.feed.every((f) => f.kind !== "progress" || !f.running)).toBe(true);
    expect(s.stageLog).toEqual([]);
    expect(s.progress).toBeNull();
  });

  it("state з тим самим статусом не скидає журнал етапу", () => {
    let s = reduceAll(base(), [stateEv("crawling", "intake", 0), progressEv("crawl", "Сканую… 1/7", 1, 7)]);
    s = reduceAll(s, [stateEv("crawling", "intake", 5, 2)]);
    expect(s.stageLog).toHaveLength(1);
    expect(s.rev).toBe(2);
    expect(s.busySince).toBe(at(0));
  });

  it("вихід з awaiting у revising → superseded, уперед → approved", () => {
    const cp = ev({
      type: "checkpoint",
      rev: 1,
      checkpoint: "script",
      payload: fixtureStates.awaitingScript?.checkpoints.script?.payload,
    });
    let s = reduceAll(base(), [stateEv("awaiting_script", "scripting", 0), cp]);
    expect(s.checkpoints.script?.state).toBe("open");
    const revised = reduceAll(s, [stateEv("revising", "awaiting_script", 5, 2)]);
    expect(revised.checkpoints.script?.state).toBe("superseded");
    s = reduceAll(s, [stateEv("directing", "awaiting_script", 5)]);
    expect(s.checkpoints.script?.state).toBe("approved");
  });

  it("artifact: upsert за format+rev, poster, music", () => {
    const video = (format: string, rev: number, url: string) =>
      ev({ type: "artifact", kind: "video", rev, format, url, sceneId: null });
    const s = reduceAll(base(), [
      video("vertical", 1, "/a"),
      video("vertical", 1, "/b"),
      video("square", 1, "/c"),
      video("vertical", 2, "/d"),
      ev({ type: "artifact", kind: "music", rev: 1, format: null, url: "/m", sceneId: null }),
      ev({ type: "artifact", kind: "poster", rev: 1, format: "vertical", url: "/p", sceneId: null }),
      ev({ type: "artifact", kind: "still", rev: 1, format: "vertical", url: "/s", sceneId: "s1" }),
    ]);
    expect(s.artifacts).toEqual({
      videos: [
        { format: "vertical", url: "/b", rev: 1 },
        { format: "square", url: "/c", rev: 1 },
        { format: "vertical", url: "/d", rev: 2 },
      ],
      poster: "/p",
      music: "/m",
    });
  });

  it("cost: totalUsd і breakdown (попередній, якщо нового немає)", () => {
    const rows = [{ stage: "crawl", usd: 0.1 }];
    let s = reduceAll(base(), [
      ev({ type: "cost", totalUsd: 1, stage: "crawl", stageUsd: 1, breakdown: rows }),
    ]);
    s = reduceAll(s, [ev({ type: "cost", totalUsd: 2, stage: "qa", stageUsd: 1 })]);
    expect(s.totalUsd).toBe(2);
    expect(s.breakdown).toEqual(rows);
  });

  it("невідомий тип події не змінює стан", () => {
    const s = base();
    expect(reduce(s, { type: "nope", at: at(0) } as unknown as ChatEvent, "1-0")).toBe(s);
  });
});

describe("reduce: відео-превʼю ЧП3", () => {
  const timeline = [
    { sceneId: "s1", fromMs: 0, durationMs: 5000 },
    { sceneId: "s2", fromMs: 4500, durationMs: 5500 },
  ];
  const boardEv = (rev: number, extra: Record<string, unknown> = {}) =>
    ev({ type: "checkpoint", rev, checkpoint: "storyboard", payload: { ...storyboardPayload, ...extra } });
  const previewEv = (rev: number, state: "ready" | "failed", url: string | null = null) =>
    ev({ type: "preview", rev, format: "vertical", state, url });
  const URL = "/files/p1/rev/1/renders/vertical.mp4";

  it("checkpoint storyboard з payload.preview → pending; preview: null → null; стара подія — без поля", () => {
    const s = reduceAll(base(), [boardEv(1, { timeline, preview: { format: "vertical" } })]);
    expect(s.checkpoints.storyboard?.preview).toEqual({ format: "vertical", state: "pending", url: null });

    expect(reduceAll(base(), [boardEv(1, { preview: null })]).checkpoints.storyboard?.preview).toBeNull();
    const old = reduceAll(base(), [boardEv(1)]).checkpoints.storyboard;
    expect(old && "preview" in old).toBe(false);
  });

  it("інші чекпоінти поля preview не мають", () => {
    const s = reduceAll(base(), eventsOf(PATHS.script));
    expect(s.checkpoints.brand && "preview" in s.checkpoints.brand).toBe(false);
    expect(s.checkpoints.script && "preview" in s.checkpoints.script).toBe(false);
  });

  it("preview з rev поточного ЧП3 → ready/failed з url; у feed не потрапляє", () => {
    const s = reduceAll(base(), [boardEv(1, { preview: { format: "vertical" } })]);
    const ready = reduceAll(s, [previewEv(1, "ready", URL)]);
    expect(ready.checkpoints.storyboard?.preview).toEqual({ format: "vertical", state: "ready", url: URL });
    expect(ready.checkpoints.storyboard?.payload).toBe(s.checkpoints.storyboard?.payload);
    expect(ready.feed).toBe(s.feed);

    const failed = reduceAll(s, [previewEv(1, "failed")]);
    expect(failed.checkpoints.storyboard?.preview).toEqual({
      format: "vertical",
      state: "failed",
      url: null,
    });
  });

  it("preview іншої ревізії або без ЧП3 — стан без змін", () => {
    const s = reduceAll(base(), [boardEv(2, { preview: { format: "vertical" } })]);
    expect(reduce(s, previewEv(1, "ready", URL).event, "9001-0")).toBe(s);
    const empty = base();
    expect(reduce(empty, previewEv(1, "ready", URL).event, "9002-0")).toBe(empty);
  });

  it("повтор події preview — ідемпотентно (той самий стан)", () => {
    const s = reduceAll(base(), [
      boardEv(1, { preview: { format: "vertical" } }),
      previewEv(1, "ready", URL),
    ]);
    const again = previewEv(1, "ready", URL);
    expect(reduce(s, again.event, again.id)).toBe(s);
  });
});
