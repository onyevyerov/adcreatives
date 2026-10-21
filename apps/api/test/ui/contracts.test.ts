// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BUSY_STATUSES, ChatEvent, compareStreamIds, computeTimeline, PROJECT_STATUSES } from "@adc/shared";
import { fixtureBrandKitFile, fixtureStoryboard } from "@adc/shared/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as events from "../../public/static/dev/fixture-events.js";
import {
  collectFixtures,
  fixtureStates,
  LEGACY_FIXTURES,
  REQUIRED_STATES,
} from "../../public/static/dev/fixture-states.js";
import { boot, SCREENS, STAGE_VIEWS } from "../../public/static/js/app.js";
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

/**
 * Фікстура блоку з акаунтом у стані «loading» (як `ws-meload` B3): `?fixture=` не має підміняти її me.
 * Ім'я з префіксом `k0-` — щоб не перетнутися з фікстурами блоків.
 */
vi.mock("../../public/static/dev/fixtures/topbar.js", async () => {
  const { initialState } = await import("../../public/static/js/initial.js");
  return { default: { "k0-meload": initialState("project", "p1") } };
});

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
  session: "session",
  notfound: "session",
};

/** Відповідь `GET /api/auth/me` для гостя: boot() без бекенду не падає й не ходить у мережу. */
function stubGuest() {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "unauthorized", message: "Потрібно увійти." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

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

  it("старі стани — без акаунта; фікстури блоків спредяться з dev/fixtures/*", () => {
    for (const name of REQUIRED_STATES) expect(LEGACY_FIXTURES).toContain(name);
    for (const name of LEGACY_FIXTURES) expect(fixtureStates[name]?.account.meStatus, name).toBe("loading");
    expect(LEGACY_FIXTURES).not.toContain("k0-meload");
    expect(fixtureStates).toHaveProperty("k0-meload");
  });

  it("collectFixtures: дублікат імені між наборами — помилка", () => {
    const s = initialState("start", null);
    expect(
      collectFixtures([
        ["a.js", { x: s }],
        ["b.js", { y: s }],
      ]),
    ).toEqual({ x: s, y: s });
    expect(() =>
      collectFixtures([
        ["a.js", { x: s }],
        ["b.js", { x: s }],
      ]),
    ).toThrow(/«x».*a\.js.*b\.js/);
  });

  const accountKeys = Object.keys(initialState("start", null).account).sort();
  const cabinetKeys = Object.keys(initialState("start", null).cabinet).sort();
  const adminKeys = Object.keys(initialState("start", null).admin).sort();

  it.each(Object.keys(fixtureStates))("%s має всі ключі UiState", (name) => {
    const s = fixture(name);
    expect(Object.keys(s).sort()).toEqual(uiKeys);
    expect(Object.keys(s.ui).sort()).toEqual(flagKeys);
    expect(Object.keys(s.account).sort()).toEqual(accountKeys);
    expect(Object.keys(s.cabinet).sort()).toEqual(cabinetKeys);
    expect(Object.keys(s.admin).sort()).toEqual(adminKeys);
    expect(Object.keys(SCREENS)).toContain(s.route);
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

  it("viewFor: системний стан сцени перевіряється до статусу", () => {
    expect(viewFor({ status: "delivered", session: "401" })).toBe("session");
    expect(viewFor({ status: "awaiting_brand", session: "404" })).toBe("notfound");
    expect(viewFor({ status: "delivered", session: "403" })).toBe("done");
    expect(viewFor({ status: "failed", session: null })).toBe("failed");
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
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  beforeEach(() => {
    stubGuest();
    history.replaceState(null, "", "/");
  });
  afterEach(() => {
    errors.mockClear();
    warns.mockClear();
    vi.unstubAllGlobals();
    document.body.textContent = "";
  });

  it("index.html має точки монтування всіх маршрутів і #overlay", () => {
    mountIndexHtml();
    for (const { root, areas } of Object.values(SCREENS)) {
      expect(document.getElementById(root), root).not.toBeNull();
      for (const [id] of areas) expect(document.getElementById(id), id).not.toBeNull();
    }
    expect(document.getElementById("stage")).not.toBeNull();
    expect(document.getElementById("overlay")).not.toBeNull();
    expect(document.getElementById("app")?.dataset.route).toBe("start");
    for (const id of ["workspace", "cabinet", "checkout", "admin"])
      expect(document.getElementById(id)?.hidden, id).toBe(true);
  });

  it("старт: монтує лише start і модалку входу, workspace прихований", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams() });
    expect(mounted()).toEqual(["start"]);
    expect(document.getElementById("app")?.dataset.route).toBe("start");
    expect(document.getElementById("workspace")?.hidden).toBe(true);
    app.destroy();
    expect(document.getElementById("overlay")?.childNodes.length).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it("boot() без бекенду: me 401 → гість, мережева помилка → гість, без падінь", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams() });
    await vi.waitFor(() => expect(app.store.getState().account.meStatus).toBe("anon"));
    app.destroy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    mountIndexHtml();
    const offline = await boot({ params: new URLSearchParams("project=p1") });
    await vi.waitFor(() => expect(offline.store.getState().account.meStatus).toBe("anon"));
    expect(offline.store.getState().route).toBe("project");
    offline.destroy();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ["cabinet=history", "cabinet", ["cab-topbar", "cab-main"]],
    ["checkout=t_1", "checkout", ["checkout"]],
    ["admin=outbox", "admin", ["admin-topbar", "admin-main"]],
  ] as const)("?%s: маршрут %s монтує свої області, решта прихована", async (query, route, ids) => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams(query) });
    expect(document.getElementById("app")?.dataset.route).toBe(route);
    expect(document.getElementById(SCREENS[route].root)?.hidden).toBe(false);
    for (const r of Object.keys(SCREENS) as (keyof typeof SCREENS)[])
      if (r !== route) expect(document.getElementById(SCREENS[r].root)?.hidden, r).toBe(true);
    expect(mounted()).toEqual([]);
    app.destroy();
    for (const id of ids) expect(document.getElementById(id)?.childNodes.length, id).toBe(0);
    expect(stubs()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("перехід між маршрутами знімає попередній екран і зупиняє потік проєкту", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams(), state: fixtureStates.awaitingBrand });
    expect(mounted()).toEqual(["topbar", "timeline", "chat", "stage"]);
    app.store.setState({ route: "cabinet" });
    expect(mounted()).toEqual([]);
    expect(document.getElementById("cabinet")?.hidden).toBe(false);
    app.store.setState({ route: "project" });
    expect(mounted()).toEqual(["topbar", "timeline", "chat", "stage"]);
    expect(document.getElementById("cab-main")?.childNodes.length).toBe(0);
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
  });

  it("session 401 / 404 → екран сцени session / notfound (views/session.js)", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams(), state: fixtureStates.awaitingBrand });
    app.store.setState({ session: "401" });
    const stub401 = stageStub();
    if (stub401) expect(stub401).toBe("session");
    const first = area("stage").firstElementChild;
    app.store.setState({ session: "404" });
    expect(area("stage").firstElementChild).not.toBe(first);
    app.store.setState({ session: null });
    expect(stageStub() ?? "cp-brand").toBe("cp-brand");
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(Object.keys(fixtureStates).filter((n) => fixtureStates[n]?.route === "project"))(
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

  it("?fixture=<стан> підвантажує стан і dev-дії; акаунт — фейковий me (Олена, 12)", async () => {
    mountIndexHtml();
    const fetch = stubGuest();
    const app = await boot({ params: new URLSearchParams("fixture=awaitingBrand") });
    expect(app.store.getState().status).toBe("awaiting_brand");
    expect(app.store.getState().account).toMatchObject({ meStatus: "ready", me: { balance: 12 } });
    expect(app.store.getState().account.me?.user.name).toBe("Олена Коваль");
    expect(mounted()).toContain("stage");
    app.actions.startEdit();
    expect(app.store.getState().ui.editing).toBe(true);
    app.actions.navigate({ route: "cabinet", section: "balance" });
    expect(app.store.getState().route).toBe("project");
    app.destroy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("?fixture=<фікстура блоку> не підміняє її акаунт (me «loading» лишається)", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams("fixture=k0-meload") });
    expect(app.store.getState().account).toMatchObject({ meStatus: "loading", me: null });
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
  });

  it("?fixture=<невідомий> → попередження і старт, без помилок", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams("fixture=n3-nope") });
    expect(app.store.getState().route).toBe("start");
    expect(warns).toHaveBeenCalled();
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
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
    const account = app.store.getState().account;
    app.actions.newProject();
    expect(mounted()).toEqual(["start"]);
    expect(document.getElementById("app")?.dataset.route).toBe("start");
    expect(app.store.getState().account).toBe(account);
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("css", () => {
  it("base.css: keyframes ac-delta і ac-scrim, reduced-motion для ac-delta — лише opacity", () => {
    const css = readFileSync(path.join(STATIC_DIR, "css", "base.css"), "utf8");
    expect(css).toMatch(/@keyframes ac-delta/);
    expect(css).toMatch(/@keyframes ac-scrim/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const delta = /@keyframes ac-delta \{([\s\S]*?)\n {2}\}/.exec(reduced)?.[1] ?? "";
    expect(delta).toMatch(/opacity/);
    expect(delta).not.toMatch(/transform/);
  });

  it("нові css блоків — з коментарем-власником", () => {
    for (const name of [
      "auth",
      "account",
      "cabinet",
      "cab-balance",
      "cab-history",
      "cab-projects",
      "cab-profile",
      "checkout",
      "admin",
      "session",
    ]) {
      const css = readFileSync(path.join(STATIC_DIR, "css", `${name}.css`), "utf8");
      expect(css, name).toMatch(/^\/\* \.[a-z]+- · B\d+ · /);
    }
  });

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
      "scrim",
      "veil",
      "danger-field",
      "ac-delta",
    ]) {
      expect(css, name).toMatch(new RegExp(`--${name}:`));
    }
  });
});
