// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { UiState } from "../../public/static/js/contracts.js";
import { sceneSegments, timelineOf } from "../../public/static/js/lib/scene-track.js";
import { createStore } from "../../public/static/js/store.js";
import {
  currentFormat,
  fileExt,
  formatClock,
  formatDuration,
  formatUsd,
  latestVideos,
  mount,
  primaryFormat,
  revisionOf,
  STAGE_LABELS,
  scrubSegments,
  stageLabel,
} from "../../public/static/js/views/done.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

function withUi(state: UiState, patch: Partial<UiState["ui"]>): UiState {
  return { ...state, ui: { ...state.ui, ...patch } };
}

function withoutScript(state: UiState): UiState {
  return { ...state, checkpoints: { ...state.checkpoints, script: null } };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.textContent = "";
  vi.restoreAllMocks();
});

function setup(state: UiState) {
  const el = document.createElement("main");
  el.id = "stage";
  document.body.append(el);
  const store = createStore(state);
  const actions = createDevActions(store);
  const view = mount(el, { store, actions });
  const off = store.subscribe((s, prev) => view.update(s, prev));
  cleanups.push(() => {
    off();
    view.destroy();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T | null;
  const $$ = <T extends Element = HTMLElement>(sel: string) => [...el.querySelectorAll<T>(sel)];
  const video = () => $<HTMLVideoElement>("video.dn-video") as HTMLVideoElement;
  const names = () => actions.calls.map((c) => c.name);
  return { el, store, actions, view, $, $$, video, names };
}

/** Задає тривалість/позицію відео (у happy-dom медіа не завантажується). */
function setMedia(video: HTMLVideoElement, duration: number, currentTime = 0) {
  Object.defineProperty(video, "duration", { configurable: true, get: () => duration });
  video.currentTime = currentTime;
}

describe("done · вибір відео", () => {
  it("для кожного формату — відео останньої ревізії, у порядку FORMATS", () => {
    const latest = latestVideos(fixture("deliveredRev2").artifacts.videos);
    expect(latest.map((v) => [v.format, v.rev, v.url])).toEqual([
      ["vertical", 2, "/static/dev/media/sample.mp4?rev=2"],
      ["square", 2, "/static/dev/media/sample-1x1.mp4?rev=2"],
    ]);
  });

  it("порядок подій не важливий; небезпечні URL відкидаються", () => {
    const latest = latestVideos([
      { format: "square", url: "/files/p/r3/square.mp4", rev: 3 },
      { format: "vertical", url: "/files/p/r2/vertical.mp4", rev: 2 },
      { format: "square", url: "/files/p/r1/square.mp4", rev: 1 },
      { format: "landscape", url: "javascript:alert(1)", rev: 1 },
    ]);
    expect(latest.map((v) => v.url)).toEqual(["/files/p/r2/vertical.mp4", "/files/p/r3/square.mp4"]);
  });

  it("основний формат — primaryFormat чекпоінта 3, інакше перший наявний; ui.doneFormat має пріоритет", () => {
    const s = fixture("delivered");
    expect(primaryFormat(s, ["vertical", "square"])).toBe("vertical");
    expect(primaryFormat(s, ["square"])).toBe("square");
    const noBoard = { ...s, checkpoints: { ...s.checkpoints, storyboard: null } };
    expect(primaryFormat(noBoard, ["square", "landscape"])).toBe("square");
    expect(currentFormat(withUi(s, { doneFormat: "square" }), ["vertical", "square"])).toBe("square");
    expect(currentFormat(withUi(s, { doneFormat: "landscape" }), ["vertical", "square"])).toBe("vertical");
  });

  it("плеєр: <video playsinline preload=metadata> останньої ревізії основного формату з постером, без нативних controls", () => {
    const { video, $, el } = setup(fixture("deliveredRev2"));
    const v = video();
    expect(v.getAttribute("src")).toBe("/static/dev/media/sample.mp4?rev=2");
    expect(v.getAttribute("poster")).toBe("/static/dev/media/poster.svg?rev=2");
    expect(v.hasAttribute("playsinline")).toBe(true);
    expect(v.getAttribute("preload")).toBe("metadata");
    expect(v.hasAttribute("controls")).toBe(false);
    expect($(".dn-player")?.dataset.format).toBe("vertical");
    expect($(".dn-frame")?.classList.contains("stripes")).toBe(false);
    expect(el.querySelectorAll("video")).toHaveLength(1);
  });

  it("ui.doneFormat обирає формат плеєра", () => {
    const { video } = setup(withUi(fixture("deliveredRev2"), { doneFormat: "square" }));
    expect(video().getAttribute("src")).toBe("/static/dev/media/sample-1x1.mp4?rev=2");
  });

  it("без відео — смугастий плейсхолдер, контроли сховані", () => {
    const s = fixture("delivered");
    const { $, video } = setup({ ...s, artifacts: { videos: [], poster: null, music: null } });
    expect($(".dn-frame")?.classList.contains("stripes")).toBe(true);
    expect(video().hidden).toBe(true);
    expect(video().hasAttribute("src")).toBe(false);
    expect($(".dn-controls")?.hidden).toBe(true);
    expect($(".dn-formats")?.hidden).toBe(true);
  });
});

describe("done · заголовок і формати", () => {
  it("eyebrow «Готово · ревізія N», «Ролик готовий.» з accent-dot, лід", () => {
    const { $ } = setup(fixture("deliveredRev2"));
    expect($(".dn-eyebrow")?.classList.contains("eyebrow")).toBe(true);
    expect($(".dn-eyebrow")?.textContent).toBe("Готово · ревізія 2");
    const title = $(".dn-title");
    expect(title?.classList.contains("display-m")).toBe(true);
    expect(title?.textContent).toBe("Ролик готовий.");
    expect(title?.querySelector(".accent-dot")?.textContent).toBe(".");
    expect($(".dn-lead")?.classList.contains("body-l")).toBe(true);
    expect(revisionOf({ rev: null, artifacts: fixture("deliveredRev2").artifacts })).toBe(2);
  });

  it("перемикач форматів: .seg з кнопками наявних форматів, поточний — aria-pressed", () => {
    const { $, $$ } = setup(fixture("delivered"));
    expect($(".dn-formats")?.classList.contains("seg")).toBe(true);
    expect($(".dn-formats")?.hidden).toBe(false);
    const opts = $$<HTMLButtonElement>(".dn-formats .seg__opt");
    expect(opts.map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["9:16", "true"],
      ["1:1", "false"],
    ]);
  });

  it("один формат — перемикача немає", () => {
    const s = fixture("delivered");
    const one = { ...s, artifacts: { ...s.artifacts, videos: s.artifacts.videos.slice(0, 1) } };
    const { $ } = setup(one);
    expect($(".dn-formats")?.hidden).toBe(true);
  });

  it("клік по формату → setDoneFormat; після update той самий <video>, змінено лише src", () => {
    const { $, $$, video, names, actions, el } = setup(fixture("deliveredRev2"));
    const before = video();
    const frame = $(".dn-frame");
    const scrub = $(".dn-scrub");
    const dl = $(".dn-dl-list")?.firstElementChild;
    const poster = before.getAttribute("poster");
    $$<HTMLButtonElement>(".dn-formats .seg__opt")[1]?.click();
    expect(names()).toContain("setDoneFormat");
    expect(actions.calls.find((c) => c.name === "setDoneFormat")?.args).toEqual(["square"]);
    expect(video()).toBe(before);
    expect(el.querySelectorAll("video")).toHaveLength(1);
    expect(before.getAttribute("src")).toBe("/static/dev/media/sample-1x1.mp4?rev=2");
    expect(before.getAttribute("poster")).toBe(poster);
    expect($(".dn-frame")).toBe(frame);
    expect($(".dn-scrub")).toBe(scrub);
    expect($(".dn-dl-list")?.firstElementChild).toBe(dl);
    expect($(".dn-player")?.dataset.format).toBe("square");
    expect($$<HTMLButtonElement>(".dn-formats .seg__opt").map((b) => b.getAttribute("aria-pressed"))).toEqual(
      ["false", "true"],
    );
  });

  it("клік по вже обраному формату нічого не кличе", () => {
    const { $$, names } = setup(fixture("delivered"));
    $$<HTMLButtonElement>(".dn-formats .seg__opt")[0]?.click();
    expect(names()).not.toContain("setDoneFormat");
  });

  it("нова ревізія → той самий <video>, новий src", () => {
    const { store, video } = setup(fixture("delivered"));
    const before = video();
    expect(before.getAttribute("src")).toBe("/static/dev/media/sample.mp4");
    const next = fixture("deliveredRev2");
    store.setState({ artifacts: next.artifacts, rev: next.rev });
    expect(video()).toBe(before);
    expect(before.getAttribute("src")).toBe("/static/dev/media/sample.mp4?rev=2");
  });

  it("update без змін даних не чіпає DOM", () => {
    const { store, $ } = setup(fixture("delivered"));
    const list = $(".dn-dl-list")?.firstElementChild;
    const cost = $(".dn-cost-table tbody")?.firstElementChild;
    const seg = $(".dn-scrub__seg");
    store.setState((s) => ({ ui: { ...s.ui, notice: "x" } }));
    expect($(".dn-dl-list")?.firstElementChild).toBe(list);
    expect($(".dn-cost-table tbody")?.firstElementChild).toBe(cost);
    expect($(".dn-scrub__seg")).toBe(seg);
  });
});

describe("done · завантаження", () => {
  it("<a download href> на кожен формат (остання ревізія) і постер", () => {
    const { $$ } = setup(fixture("deliveredRev2"));
    const links = $$<HTMLAnchorElement>("a.dn-dl");
    expect(links).toHaveLength(3);
    for (const a of links) expect(a.hasAttribute("download")).toBe(true);
    expect(links.map((a) => [a.dataset.kind, a.getAttribute("href")])).toEqual([
      ["video", "/static/dev/media/sample.mp4?rev=2"],
      ["video", "/static/dev/media/sample-1x1.mp4?rev=2"],
      ["poster", "/static/dev/media/poster.svg?rev=2"],
    ]);
    expect(links.map((a) => a.getAttribute("download"))).toEqual([
      "adcreative-9x16-r2.mp4",
      "adcreative-1x1-r2.mp4",
      "adcreative-poster-r2.svg",
    ]);
  });

  it("рядки C7: «MP4 · 9:16» + «1080×1920 · 15 с · h264 + aac», «Постер» + тип з розширення", () => {
    const { $$ } = setup(fixture("delivered"));
    const rows = $$("a.dn-dl").map((a) => [
      a.querySelector(".dn-dl__name")?.textContent,
      a.querySelector(".dn-dl__meta")?.textContent,
      a.getAttribute("aria-label"),
    ]);
    expect(rows).toEqual([
      ["MP4 · 9:16", "1080×1920 · 15 с · h264 + aac", "Завантажити 9:16 · 1080×1920 · MP4"],
      ["MP4 · 1:1", "1080×1080 · 15 с · h264 + aac", "Завантажити 1:1 · 1080×1080 · MP4"],
      ["Постер", "SVG · 9:16 · кадр заклику", "Завантажити постер · SVG · 9:16 · кадр заклику"],
    ]);
    expect($$("a.dn-dl .dn-dl__icon.btn-round.btn-round--ghost").map((i) => i.textContent)).toEqual([
      "↓",
      "↓",
      "↓",
    ]);
  });

  it("16:9 → 1920×1080; без тривалості — без «с»; тривалість з <video> після loadedmetadata", () => {
    const s = withoutScript(fixture("delivered"));
    const { $$, video } = setup({
      ...s,
      artifacts: {
        videos: [{ format: "landscape", url: "/files/p/r1/landscape.mp4", rev: 1 }],
        poster: "/files/p/r1/poster.png",
        music: null,
      },
    });
    const meta = () => $$(".dn-dl__meta").map((m) => m.textContent);
    expect(meta()).toEqual(["1920×1080 · h264 + aac", "PNG · 16:9 · кадр заклику"]);
    setMedia(video(), 16.5);
    video().dispatchEvent(new Event("loadedmetadata"));
    expect(meta()[0]).toBe("1920×1080 · 16,5 с · h264 + aac");
  });

  it("хелпери: fileExt, formatDuration", () => {
    expect(fileExt("/files/p/r2/poster.png?rev=2")).toBe("PNG");
    expect(fileExt("/files/p/noext")).toBeNull();
    expect(formatDuration(15)).toBe("15 с");
    expect(formatDuration(16.5)).toBe("16,5 с");
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(null)).toBeNull();
  });
});

describe("done · витрати", () => {
  it("рядки breakdown з людськими назвами, $0.00 і підсумок з машинним часом", () => {
    const s = fixture("delivered");
    const { $$, $ } = setup(s);
    const rows = $$(".dn-cost-table tbody tr").map((tr) => [
      tr.dataset.stage,
      tr.querySelector(".dn-cost__stage")?.textContent,
      tr.querySelector(".dn-cost__usd")?.textContent,
    ]);
    expect(rows).toEqual([
      ["crawl", "Сканування сайту", "$0.02"],
      ["brandkit", "Бренд-кіт", "$0.31"],
      ["storyboard", "Сценарій", "$0.46"],
      ["codegen", "Генерація сцен", "$1.08"],
      ["qa", "Контроль якості", "$0.12"],
      ["audio", "Музика і звук", "$0.32"],
    ]);
    const total = $(".dn-cost--total");
    // busyMs 131500 → 02:11
    expect(total?.querySelector(".dn-cost__stage")?.textContent).toBe("Разом · машинний час 02:11");
    expect(total?.querySelector(".dn-cost__usd")?.textContent).toBe("$2.31");
    const sum = (s.breakdown ?? []).reduce((acc, r) => acc + r.usd, 0);
    expect(formatUsd(sum)).toBe("$2.31");
  });

  it("без breakdown — лише підсумок", () => {
    const { $$, $ } = setup({ ...fixture("delivered"), breakdown: null, totalUsd: 1.5, busyMs: 59_000 });
    expect($$(".dn-cost-table tbody tr")).toHaveLength(0);
    expect($(".dn-cost--total")?.textContent).toBe("Разом · машинний час 00:59$1.50");
  });

  it("зміна totalUsd оновлює підсумок", () => {
    const { store, $ } = setup(fixture("delivered"));
    store.setState({ totalUsd: 3.456 });
    expect($(".dn-cost--total .dn-cost__usd")?.textContent).toBe("$3.46");
  });

  it("STAGE_LABELS покриває всі CostStage; невідома стадія — як є", () => {
    for (const stage of [
      "crawl",
      "ingest",
      "brandkit",
      "brandkit-patch",
      "storyboard",
      "codegen",
      "check",
      "fix",
      "qa",
      "revise",
      "audio",
      "render",
      "chat-intent",
      "chat-reply",
      "sfx-cache",
      "live",
    ]) {
      expect(STAGE_LABELS[stage], stage).toBeTruthy();
    }
    expect(stageLabel("mystery")).toBe("mystery");
  });
});

describe("done · скраббер", () => {
  it("сегменти — межі сцен з payload чекпоінта 2", () => {
    const s = fixture("delivered");
    const expected = sceneSegments(timelineOf(s.checkpoints.script?.payload) ?? (null as never));
    expect(scrubSegments(s)).toEqual(
      expected.map((x) => ({ id: x.id, startPct: x.startPct, endPct: x.endPct })),
    );
    const { $$ } = setup(s);
    const segs = $$(".dn-scrub__seg");
    expect(segs.map((x) => x.dataset.scene)).toEqual(["s1", "s2", "s3"]);
    expect(segs[0]?.style.getPropertyValue("--l")).toBe("0%");
    const last = expected.at(-1);
    expect(last?.endPct).toBe(100);
  });

  it("без чекпоінта 2 — один сегмент на весь ролик", () => {
    const s = withoutScript(fixture("delivered"));
    expect(scrubSegments(s)).toEqual([{ id: "all", startPct: 0, endPct: 100 }]);
    const { $$ } = setup(s);
    const segs = $$(".dn-scrub__seg");
    expect(segs).toHaveLength(1);
    expect(segs[0]?.style.getPropertyValue("--w")).toBe("100%");
  });

  it("role=slider з aria-атрибутами; заповнення і тайм-код після timeupdate", () => {
    const { $, $$, video } = setup(fixture("delivered"));
    const scrub = $(".dn-scrub");
    expect(scrub?.getAttribute("role")).toBe("slider");
    expect(scrub?.getAttribute("tabindex")).toBe("0");
    expect($(".dn-time")?.textContent).toBe("00:00 / 00:00");
    setMedia(video(), 15, 7.4);
    video().dispatchEvent(new Event("timeupdate"));
    expect($(".dn-time")?.textContent).toBe("00:07 / 00:15");
    expect(scrub?.getAttribute("aria-valuenow")).toBe("7");
    expect(scrub?.getAttribute("aria-valuemax")).toBe("15");
    expect(scrub?.getAttribute("aria-valuetext")).toBe("00:07 з 00:15");
    // 7.4 / 15 ≈ 49.3%: s1 (0…~32%) заповнений, s2 частково, s3 порожній
    const fills = $$(".dn-scrub__fill").map((f) => Number(f.style.getPropertyValue("--fill")));
    expect(fills[0]).toBe(1);
    expect(fills[1]).toBeGreaterThan(0);
    expect(fills[1]).toBeLessThan(1);
    expect(fills[2]).toBe(0);
    expect($$(".dn-scrub__seg").map((x) => x.classList.contains("is-current"))).toEqual([false, true, false]);
  });

  it("клавіатура: стрілки ±1 с, Shift ±5 с, Home/End", () => {
    const { $, video } = setup(fixture("delivered"));
    setMedia(video(), 15, 7);
    const scrub = $(".dn-scrub") as HTMLElement;
    const key = (k: string, shiftKey = false) =>
      scrub.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }),
      );
    key("ArrowRight");
    expect(video().currentTime).toBe(8);
    key("ArrowLeft", true);
    expect(video().currentTime).toBe(3);
    key("Home");
    expect(video().currentTime).toBe(0);
    key("ArrowLeft");
    expect(video().currentTime).toBe(0);
    key("End");
    expect(video().currentTime).toBe(15);
    expect($(".dn-time")?.textContent).toBe("00:15 / 00:15");
  });

  it("клік/перетягування по скрабберу — seek", () => {
    const { $, video } = setup(fixture("delivered"));
    setMedia(video(), 15, 0);
    const scrub = $(".dn-scrub") as HTMLElement;
    const track = $(".dn-scrub__track") as HTMLElement;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 100,
      width: 300,
      top: 0,
      height: 4,
      right: 400,
      bottom: 4,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    scrub.dispatchEvent(new PointerEvent("pointerdown", { clientX: 250, button: 0, bubbles: true }));
    expect(video().currentTime).toBeCloseTo(7.5);
    scrub.dispatchEvent(new PointerEvent("pointermove", { clientX: 340, bubbles: true }));
    expect(video().currentTime).toBeCloseTo(12);
    scrub.dispatchEvent(new PointerEvent("pointerup", { clientX: 340, bubbles: true }));
    scrub.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, bubbles: true }));
    expect(video().currentTime).toBeCloseTo(12);
    expect($(".dn-time")?.textContent).toBe("00:12 / 00:15");
  });
});

describe("done · play/pause", () => {
  let play: ReturnType<typeof vi.spyOn>;
  let pause: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { configurable: true, get: () => false });
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      Object.defineProperty(this, "paused", { configurable: true, get: () => true });
      this.dispatchEvent(new Event("pause"));
    });
  });

  it("кнопка 40 px перемикає play/pause і гліф", () => {
    const { $ } = setup(fixture("delivered"));
    const btn = $<HTMLButtonElement>(".dn-play") as HTMLButtonElement;
    expect(btn.classList.contains("btn-round")).toBe(true);
    expect(btn.classList.contains("btn-round--40")).toBe(true);
    expect(btn.querySelector(".icon-play")).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Відтворити");
    btn.click();
    expect(play).toHaveBeenCalledTimes(1);
    expect(btn.querySelector(".icon-pause")).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Пауза");
    btn.click();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(btn.querySelector(".icon-play")).not.toBeNull();
  });

  it("клік по відео — play/pause; ended повертає гліф play", () => {
    const { $, video } = setup(fixture("delivered"));
    video().click();
    expect(play).toHaveBeenCalledTimes(1);
    expect($(".dn-play .icon-pause")).not.toBeNull();
    video().dispatchEvent(new Event("ended"));
    expect($(".dn-play .icon-play")).not.toBeNull();
  });

  it("destroy ставить на паузу і знімає слухачі", () => {
    const { view, video, el } = setup(fixture("delivered"));
    const v = video();
    v.click();
    cleanups.length = 0;
    view.destroy();
    expect(pause).toHaveBeenCalled();
    expect(el.querySelector(".dn")).toBeNull();
    play.mockClear();
    v.click();
    expect(play).not.toHaveBeenCalled();
  });
});

describe("done · безпека й стиль", () => {
  it("formatClock — mm:ss", () => {
    expect(formatClock(7.9)).toBe("00:07");
    expect(formatClock(75)).toBe("01:15");
    expect(formatClock(Number.NaN)).toBe("00:00");
  });

  it("у модулі немає innerHTML / eval / інлайнових on*-атрибутів", () => {
    const src = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "static/js/views/done.js"), "utf8");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
    expect(src).not.toMatch(/setAttribute\(\s*["']on/);
  });

  it("CSS: лише клас-префікс .dn-, тінь плеєра і висоти з ТЗ", () => {
    const css = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "static/css/done.css"), "utf8");
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/\.[a-z][\w-]*/g)
      ?.filter((c) => !/^\.\d/.test(c));
    for (const c of new Set(selectors)) {
      expect(c === ".dn" || c === ".is-current" || c === ".stripes" || c.startsWith(".dn-"), c).toBe(true);
    }
    expect(css).toContain("var(--shadow-player)");
    expect(css).toContain("var(--r-14)");
    expect(css).toContain("clamp(380px, 100vh - 260px, 640px)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
