// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BUSY_STATUSES, ChatEvent, compareStreamIds, computeTimeline, PROJECT_STATUSES } from "@adc/shared";
import { fixtureBrandKitFile, fixtureStoryboard } from "@adc/shared/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as events from "../../public/static/dev/fixture-events.js";
import { fixtureStates, REQUIRED_STATES } from "../../public/static/dev/fixture-states.js";
import { boot, STAGE_VIEWS } from "../../public/static/js/app.js";
import type { StageView, UiState } from "../../public/static/js/contracts.js";
import {
  AWAITING,
  BUSY,
  CHECKPOINT_STATUS,
  FORMATS,
  SEGMENTS,
  STATUS_LABELS,
  STATUSES,
} from "../../public/static/js/contracts.js";
import { h, lines, text } from "../../public/static/js/dom.js";
import { initialState } from "../../public/static/js/initial.js";
import { createStore } from "../../public/static/js/store.js";
import { viewFor } from "../../public/static/js/view.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

const STATIC_DIR = path.join(DEFAULT_PUBLIC_DIR, "static");

/** Розмітка <body> справжнього index.html (у тесті innerHTML дозволено; у public — ні). */
function mountIndexHtml() {
  const html = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
  if (!body) throw new Error("index.html без <body>");
  document.body.innerHTML = body;
}

/** Стан фікстури за назвою (падає, якщо немає). */
function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

/** Екран сцени → файл views/*.js (= data-stub заглушки). */
const STAGE_FILES: Record<StageView, string> = {
  progress: "stage-progress",
  brand: "cp-brand",
  script: "cp-script",
  board: "cp-board",
  done: "done",
  failed: "failed",
};

const stubs = () => [...document.querySelectorAll("[data-stub]")].map((n) => n.getAttribute("data-stub"));

/** Області, куди app.js монтує view (заглушки поступово замінюються справжніми view). */
const AREAS = ["start", "topbar", "timeline", "chat", "stage"] as const;
const area = (id: (typeof AREAS)[number]) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`немає #${id}`);
  return el;
};
/** Непорожні області. */
const mounted = () => AREAS.filter((id) => area(id).childNodes.length > 0);
/** Заглушка екрана сцени, якщо блок ще не замінив її справжнім view. */
const stageStub = () => area("stage").querySelector("[data-stub]")?.getAttribute("data-stub") ?? null;

describe("fixture-events.js", () => {
  it("кожна подія проходить ChatEvent.parse", () => {
    expect(events.allEvents.length).toBeGreaterThan(50);
    for (const { id, event } of events.allEvents) {
      const res = ChatEvent.safeParse(event);
      expect(res.success, `${id} ${event.type}: ${res.error?.message}`).toBe(true);
    }
  });

  it("ID унікальні і монотонні в кожному шляху програвання", () => {
    const ids = events.allEvents.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [name, path_] of Object.entries(events.PATHS)) {
      const list = events.eventsOf(path_);
      for (let i = 1; i < list.length; i++) {
        expect(compareStreamIds(list[i - 1]?.id ?? "", list[i]?.id ?? ""), `${name} #${i}`).toBeLessThan(0);
      }
    }
  });

  it("дані «Зерна» збігаються з @adc/shared/fixtures", () => {
    expect(events.brandkitFile).toEqual(fixtureBrandKitFile);
    expect(events.storyboard).toEqual(fixtureStoryboard);
    expect(events.scriptPayload.durationSeconds).toBe(computeTimeline(fixtureStoryboard).durationSeconds);
  });

  it("кожен сегмент до чекпоінта закінчується чекпоінтом, видача — state delivered", () => {
    const last = (name: keyof typeof events.segments) => events.segments[name].at(-1)?.event;
    expect(last("toBrand")).toMatchObject({ type: "checkpoint", checkpoint: "brand" });
    expect(last("toScript")).toMatchObject({ type: "checkpoint", checkpoint: "script" });
    expect(last("toStoryboard")).toMatchObject({ type: "checkpoint", checkpoint: "storyboard" });
    expect(last("retry")).toMatchObject({ type: "checkpoint", checkpoint: "storyboard" });
    expect(last("revisionAfterDelivery")).toMatchObject({
      type: "checkpoint",
      checkpoint: "storyboard",
      rev: 2,
    });
    const states = (name: keyof typeof events.segments) =>
      events.segments[name].flatMap(({ event }) => (event.type === "state" ? [event.status] : []));
    expect(states("toDelivered").at(-1)).toBe("delivered");
    expect(states("revisionDelivered").at(-1)).toBe("delivered");
    expect(states("failed").at(-1)).toBe("failed");
    expect(events.segments.failed.some(({ event }) => event.type === "error" && event.retryable)).toBe(true);
  });

  it("медіа з фікстури лежать у public/static", () => {
    const urls = new Set<string>();
    JSON.stringify(events.allEvents, (_k, v) => {
      if (typeof v === "string" && v.startsWith("/static/")) urls.add(v.split("?")[0] as string);
      return v;
    });
    expect(urls.size).toBeGreaterThan(5);
    for (const url of urls) {
      expect(existsSync(path.join(DEFAULT_PUBLIC_DIR, url)), url).toBe(true);
    }
  });
});

describe("fixture-states.js", () => {
  const uiKeys = Object.keys(initialState("start", null)).sort();
  const flagKeys = Object.keys(initialState("start", null).ui).sort();

  it("є всі стани з ТЗ", () => {
    for (const name of REQUIRED_STATES) expect(fixtureStates, name).toHaveProperty(name);
  });

  it.each(Object.keys(fixtureStates))("%s має всі ключі UiState", (name) => {
    const s = fixture(name);
    expect(Object.keys(s).sort()).toEqual(uiKeys);
    expect(Object.keys(s.ui).sort()).toEqual(flagKeys);
    expect(Object.keys(s.checkpoints).sort()).toEqual(["brand", "script", "storyboard"]);
    expect(Object.keys(s.artifacts).sort()).toEqual(["music", "poster", "videos"]);
    expect(STATUSES).toContain(s.status);
    for (const item of s.feed) expect(["message", "progress", "checkpoint", "error"]).toContain(item.kind);
  });

  it("стани відповідають своїм екранам", () => {
    const status = (name: string) => fixtureStates[name]?.status;
    expect(fixtureStates.start?.route).toBe("start");
    expect(status("crawling")).toBe("crawling");
    expect(fixtureStates.crawling?.progress).toMatchObject({ done: 4, total: 7 });
    expect(status("brandkit")).toBe("brandkit");
    expect(status("awaitingBrand")).toBe("awaiting_brand");
    expect(fixtureStates.awaitingBrand?.checkpoints.brand?.state).toBe("open");
    expect(status("awaitingScript")).toBe("awaiting_script");
    expect(fixtureStates.awaitingScript?.checkpoints.brand?.state).toBe("approved");
    expect(status("directing")).toBe("directing");
    expect(status("awaitingStoryboard")).toBe("awaiting_storyboard");
    expect(status("rendering")).toBe("rendering");
    expect(status("delivered")).toBe("delivered");
    expect(fixtureStates.delivered?.artifacts.videos.map((v) => v.format)).toEqual(["vertical", "square"]);
    expect(fixtureStates.delivered?.breakdown?.length).toBeGreaterThan(0);
    expect(fixtureStates.delivered?.busyMs).toBeGreaterThan(0);
    expect(status("failed")).toBe("failed");
    expect(fixtureStates.failed?.error).toMatchObject({ stage: "codegen", retryable: true });
    expect(status("revising")).toBe("revising");
    expect(fixtureStates.revising?.rev).toBe(2);
  });
});

describe("contracts.js / view.js", () => {
  it("статуси й busy збігаються з @adc/shared", () => {
    expect([...STATUSES]).toEqual([...PROJECT_STATUSES]);
    expect([...BUSY]).toEqual([...BUSY_STATUSES]);
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...PROJECT_STATUSES].sort());
    expect(Object.values(CHECKPOINT_STATUS).sort()).toEqual([...AWAITING].sort());
    expect([...FORMATS]).toEqual(["vertical", "square", "landscape"]);
  });

  it("ваги сегментів дають ромби з C3", () => {
    const sum = SEGMENTS.reduce((a, s) => a + s.weight, 0);
    expect(sum).toBeCloseTo(6.7);
    let acc = 0;
    const diamonds: number[] = [];
    for (const s of SEGMENTS) {
      acc += s.weight;
      if (s.checkpoint) diamonds.push(Math.round((acc / sum) * 10000) / 100);
    }
    expect(diamonds).toEqual([34.33, 52.24, 76.12]);
  });

  it.each([...PROJECT_STATUSES])("viewFor(%s) — відомий екран сцени", (status) => {
    expect(Object.keys(STAGE_VIEWS)).toContain(viewFor({ status }));
  });

  it("viewFor мапить статуси за ТЗ", () => {
    const map = Object.fromEntries(PROJECT_STATUSES.map((status) => [status, viewFor({ status })]));
    expect(map).toEqual({
      intake: "progress",
      crawling: "progress",
      brandkit: "progress",
      scripting: "progress",
      directing: "progress",
      rendering: "progress",
      revising: "progress",
      awaiting_brand: "brand",
      awaiting_script: "script",
      awaiting_storyboard: "board",
      delivered: "done",
      failed: "failed",
    });
  });
});

describe("store.js / dom.js", () => {
  it("store зливає патч і сповіщає лише про зміни", () => {
    const store = createStore({ a: 1, b: { c: 2 } });
    const seen: Array<[number, number]> = [];
    const off = store.subscribe((s, prev) => seen.push([s.a, prev.a]));
    store.setState({ a: 1 });
    store.setState({ a: 2 });
    store.setState((s) => ({ a: s.a + 1 }));
    off();
    store.setState({ a: 10 });
    expect(seen).toEqual([
      [2, 1],
      [3, 2],
    ]);
    expect(store.getState()).toEqual({ a: 10, b: { c: 2 } });
  });

  it("h() ставить текст лише через textContent і вішає обробники", () => {
    const onClick = vi.fn();
    const node = h("button", {
      class: "btn",
      text: "<b>x</b>",
      onclick: onClick,
      disabled: true,
      hidden: false,
    });
    expect(node.textContent).toBe("<b>x</b>");
    expect(node.querySelector("b")).toBeNull();
    expect(node.hasAttribute("disabled")).toBe(true);
    expect(node.hasAttribute("hidden")).toBe(false);
    node.dispatchEvent(new Event("click"));
    expect(onClick).toHaveBeenCalledOnce();
    const p = h("p", { style: { "--bar-value": 0.5 } }, "a", ["b", null, "c"], false, 1);
    expect(p.textContent).toBe("abc1");
    expect(p.style.getPropertyValue("--bar-value")).toBe("0.5");
    const area = h("textarea", { value: "чернетка" });
    expect(area.value).toBe("чернетка");
    text(p, "нове");
    expect(p.textContent).toBe("нове");
    expect(h("div", null, lines("a\nb")).querySelectorAll("br").length).toBe(1);
  });

  it("у public немає innerHTML, eval і інлайнових on*-атрибутів", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(js|html)$/.test(name)) files.push(p);
      }
    };
    walk(DEFAULT_PUBLIC_DIR);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function\(/);
      if (f.endsWith(".html")) expect(src, f).not.toMatch(/\son[a-z]+=/i);
    }
  });
});

describe("app.js", () => {
  const errors = vi.spyOn(console, "error");
  afterEach(() => {
    errors.mockClear();
    document.body.textContent = "";
  });

  it("старт: монтує лише start, workspace прихований", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams() });
    expect(mounted()).toEqual(["start"]);
    expect(document.getElementById("app")?.dataset.route).toBe("start");
    expect(document.getElementById("workspace")?.hidden).toBe(true);
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(Object.keys(fixtureStates).filter((n) => n !== "start"))(
    "фікстура %s: монтує топбар, таймлайн, діалог, композер і свій екран сцени",
    async (name) => {
      mountIndexHtml();
      const state = fixture(name);
      const app = await boot({ params: new URLSearchParams(), state });
      expect(document.getElementById("start")?.hidden).toBe(true);
      expect(document.getElementById("workspace")?.hidden).toBe(false);
      expect(mounted()).toEqual(["topbar", "timeline", "chat", "stage"]);
      const stub = stageStub();
      if (stub) expect(stub).toBe(STAGE_FILES[viewFor(state)]);
      app.destroy();
      expect(mounted()).toEqual([]);
      expect(stubs()).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it("?fixture=<стан> підвантажує стан і dev-дії", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams("fixture=awaitingBrand") });
    expect(app.store.getState().status).toBe("awaiting_brand");
    expect(mounted()).toContain("stage");
    app.actions.startEdit();
    expect(app.store.getState().ui.editing).toBe(true);
    app.destroy();
  });

  it("зміна статусу міняє екран сцени, решта view оновлюються на місці", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams(), state: fixtureStates.awaitingBrand });
    const topbar = area("topbar").firstElementChild;
    const brandStage = area("stage").firstElementChild;
    app.store.setState({ status: "scripting" });
    const progressStage = area("stage").firstElementChild;
    expect(progressStage).not.toBe(brandStage);
    expect(area("topbar").firstElementChild).toBe(topbar);
    expect(topbar?.textContent).toContain(STATUS_LABELS.scripting);
    app.store.setState({ status: "delivered" });
    expect(area("stage").firstElementChild).not.toBe(progressStage);
    app.actions.newProject();
    expect(mounted()).toEqual(["start"]);
    expect(document.getElementById("app")?.dataset.route).toBe("start");
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("css", () => {
  it("index.html підключає всі css і файли існують", () => {
    const html = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "index.html"), "utf8");
    const linked = [...html.matchAll(/href="\/static\/css\/([^"]+)"/g)].map((m) => m[1]);
    const onDisk = readdirSync(path.join(STATIC_DIR, "css")).sort();
    expect([...linked].sort()).toEqual(onDisk);
    expect(linked.slice(0, 3)).toEqual(["tokens.css", "base.css", "components.css"]);
  });

  it("tokens.css визначає всі токени з ТЗ", () => {
    const css = readFileSync(path.join(STATIC_DIR, "css", "tokens.css"), "utf8");
    for (const name of [
      "paper",
      "chat",
      "stage",
      "card",
      "ink",
      "ink-2",
      "muted",
      "accent",
      "danger",
      "ok",
      "line",
      "line-strong",
      "track-2",
      "track-3",
      "ease",
      "r-4",
      "r-6",
      "r-10",
      "r-12",
      "r-14",
      "r-16",
      "r-20",
      "r-pill",
      "f-display",
      "f-ui",
      "f-mono",
    ]) {
      expect(css, name).toMatch(new RegExp(`--${name}:`));
    }
  });
});
