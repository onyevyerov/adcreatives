// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { UiState } from "../../public/static/js/contracts.js";
import { initialState } from "../../public/static/js/initial.js";
import {
  formatMachineTime,
  machineMs,
  positionStatus,
  renderFormats,
  TOTAL_WEIGHT,
  timelinePosition,
} from "../../public/static/js/lib/timeline.js";
import { createStore } from "../../public/static/js/store.js";
import { mount, TICK_MS } from "../../public/static/js/views/timeline.js";

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pctOf = (name: string) => round2(timelinePosition(fixture(name)).pct);
const DIAMONDS = [34.33, 52.24, 76.12];

describe("timelinePosition", () => {
  it("ваги дають 6.7, ромби на 34.33 / 52.24 / 76.12", () => {
    expect(TOTAL_WEIGHT).toBeCloseTo(6.7);
    const pos = timelinePosition(fixture("crawling"));
    expect(pos.diamonds.map((d) => round2(d.pct))).toEqual(DIAMONDS);
    expect(pos.diamonds.map((d) => d.checkpoint)).toEqual(["brand", "script", "storyboard"]);
  });

  it("start / intake — 0", () => {
    expect(timelinePosition(fixture("start"))).toMatchObject({ segIndex: 0, fraction: 0, pct: 0 });
    expect(timelinePosition(initialState("project", "p1")).pct).toBe(0);
  });

  it("crawling 4/7 — 8.53 (C3)", () => {
    const pos = timelinePosition(fixture("crawling"));
    expect(pos.segIndex).toBe(0);
    expect(pos.fraction).toBeCloseTo(4 / 7);
    expect(round2(pos.pct)).toBe(8.53);
  });

  it("crawling без done/total — 0", () => {
    const s = {
      ...fixture("crawling"),
      progress: { stage: "crawl", label: "Сканую сайт…", done: null, total: null },
    };
    expect(timelinePosition(s).pct).toBe(0);
  });

  it("brandkit без прогресу — частка 0.5; з прогресом — ×0.92", () => {
    const s = fixture("brandkit");
    expect(timelinePosition(s)).toMatchObject({ segIndex: 1, fraction: 0.5 });
    expect(pctOf("brandkit")).toBe(round2(((1 + 1.3 * 0.5) / 6.7) * 100));
    const withDone = { ...s, progress: { stage: "brandkit", label: "x", done: 1, total: 2 } };
    expect(timelinePosition(withDone).fraction).toBeCloseTo(0.46);
  });

  it("awaiting_* — на ромбі: 34.33 / 52.24 / 76.12", () => {
    expect(pctOf("awaitingBrand")).toBe(34.33);
    expect(pctOf("awaitingScript")).toBe(52.24);
    expect(pctOf("awaitingStoryboard")).toBe(76.12);
    expect(timelinePosition(fixture("awaitingBrand")).fraction).toBe(1);
  });

  it("directing 2/3 — (1+1.3+1.2 + 1.6·2/3·0.92)/6.7", () => {
    const pos = timelinePosition(fixture("directing"));
    expect(pos.segIndex).toBe(3);
    expect(pos.pct).toBeCloseTo(((3.5 + 1.6 * (2 / 3) * 0.92) / 6.7) * 100, 6);
  });

  it("rendering 9:16 50% з двох форматів — (0 + 0.5)/2", () => {
    const s = fixture("rendering");
    expect(renderFormats(s)).toEqual(["9:16", "1:1"]);
    const pos = timelinePosition(s);
    expect(pos.segIndex).toBe(4);
    expect(pos.fraction).toBe(0.25);
    expect(round2(pos.pct)).toBe(79.85);
    // другий формат
    const second = { ...s, progress: { stage: "render", label: "Рендерю 1:1… 50%", done: 50, total: 100 } };
    expect(timelinePosition(second).fraction).toBe(0.75);
  });

  it("rendering без мітки старту — формати з payload бренду / pendingFormats, інакше 1", () => {
    const s = fixture("rendering");
    const bare = {
      ...s,
      stageLog: [],
      progress: { stage: "render", label: "Рендерю 9:16… 50%", done: 50, total: 100 },
    };
    // payload бренду: лише vertical → один формат
    expect(timelinePosition(bare).fraction).toBe(0.5);
    const pending = {
      ...bare,
      ui: { ...bare.ui, pendingFormats: ["vertical", "landscape"] as UiState["ui"]["pendingFormats"] },
    };
    expect(renderFormats(pending)).toEqual(["9:16", "16:9"]);
    expect(timelinePosition(pending).fraction).toBe(0.25);
    const none = { ...bare, checkpoints: { brand: null, script: null, storyboard: null } };
    expect(renderFormats(none)).toEqual(["9:16"]);
  });

  it("delivered — рівно 100, усе пройдено", () => {
    const pos = timelinePosition(fixture("delivered"));
    expect(pos.pct).toBe(100);
    expect(pos.segIndex).toBe(5);
    expect(pos.diamonds.map((d) => d.state)).toEqual(["done", "done", "done"]);
    expect(pos.labels.map((l) => l.state)).toEqual(Array(6).fill("done"));
  });

  it("failed після directing — позиція directing без прогресу", () => {
    const s = fixture("failed");
    expect(s.prevStatus).toBe("directing");
    expect(positionStatus(s)).toBe("directing");
    const pos = timelinePosition(s);
    expect(pos.segIndex).toBe(3);
    expect(pos.fraction).toBe(0.5);
    expect(pos.diamonds.map((d) => d.state)).toEqual(["done", "done", "open"]);
  });

  it("revising після delivered — 100; після awaiting_X — на ромбі X, без пульсу", () => {
    expect(timelinePosition(fixture("revising")).pct).toBe(100);
    const fromBrand = {
      ...fixture("awaitingBrand"),
      status: "revising" as const,
      prevStatus: "awaiting_brand" as const,
    };
    const pos = timelinePosition(fromBrand);
    expect(round2(pos.pct)).toBe(34.33);
    expect(pos.diamonds.map((d) => d.state)).toEqual(["open", "open", "open"]);
    const fromScript = {
      ...fixture("awaitingScript"),
      status: "revising" as const,
      prevStatus: "awaiting_script" as const,
    };
    expect(round2(timelinePosition(fromScript).pct)).toBe(52.24);
  });

  it("failed/revising без відомого prevStatus — найдальша точка зі стану", () => {
    const s = { ...fixture("awaitingScript"), status: "failed" as const, prevStatus: "revising" as const };
    expect(positionStatus(s)).toBe("awaiting_script");
    expect(positionStatus({ ...fixture("delivered"), status: "failed", prevStatus: null })).toBe("delivered");
    expect(positionStatus({ ...initialState("project", "p"), status: "failed", prevStatus: null })).toBe(
      "intake",
    );
  });

  it("стани ромбів і підписів", () => {
    const crawling = timelinePosition(fixture("crawling"));
    expect(crawling.diamonds.map((d) => d.state)).toEqual(["open", "open", "open"]);
    expect(crawling.labels.map((l) => [l.num, l.label, l.state])).toEqual([
      ["01", "Сайт", "active"],
      ["02", "Бренд-кіт", "todo"],
      ["03", "Сценарій", "todo"],
      ["04", "Сцени і музика", "todo"],
      ["05", "Рендер", "todo"],
      ["06", "Готово", "todo"],
    ]);
    const brand = timelinePosition(fixture("awaitingBrand"));
    expect(brand.diamonds.map((d) => d.state)).toEqual(["ring", "open", "open"]);
    expect(brand.labels.map((l) => l.state)).toEqual(["done", "active", "todo", "todo", "todo", "todo"]);
    expect(timelinePosition(fixture("awaitingScript")).diamonds.map((d) => d.state)).toEqual([
      "done",
      "ring",
      "open",
    ]);
    expect(timelinePosition(fixture("awaitingStoryboard")).diamonds.map((d) => d.state)).toEqual([
      "done",
      "done",
      "ring",
    ]);
    expect(timelinePosition(fixture("rendering")).labels.map((l) => l.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "active",
      "todo",
    ]);
  });

  it("кожна фікстура дає pct у [0, 100] і монотонно росте шляхом пайплайна", () => {
    const order = [
      "start",
      "crawling",
      "brandkit",
      "awaitingBrand",
      "awaitingScript",
      "directing",
      "awaitingStoryboard",
      "rendering",
      "delivered",
    ];
    const pcts = order.map((n) => timelinePosition(fixture(n)).pct);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThan(pcts[i - 1] as number);
    for (const n of Object.keys(fixtureStates)) {
      const { pct } = timelinePosition(fixture(n));
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });
});

describe("машинний час", () => {
  it("formatMachineTime — mm:ss", () => {
    expect(formatMachineTime(0)).toBe("00:00");
    expect(formatMachineTime(4_999)).toBe("00:04");
    expect(formatMachineTime(134_000)).toBe("02:14");
    expect(formatMachineTime(75 * 60_000)).toBe("75:00");
    expect(formatMachineTime(-5)).toBe("00:00");
    expect(formatMachineTime(Number.NaN)).toBe("00:00");
  });

  it("machineMs — busyMs + поточний busy-інтервал", () => {
    const since = "2026-10-06T10:00:00.000Z";
    const now = Date.parse(since) + 7_000;
    expect(machineMs({ status: "crawling", busyMs: 1_000, busySince: since }, now)).toBe(8_000);
    expect(machineMs({ status: "awaiting_brand", busyMs: 1_000, busySince: since }, now)).toBe(1_000);
    expect(machineMs({ status: "delivered", busyMs: 131_500, busySince: null }, now)).toBe(131_500);
  });
});

describe("views/timeline.js", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.textContent = "";
  });

  function mountWith(state: UiState) {
    const store = createStore(state);
    const view = mount(host, { store, actions: createDevActions(store) });
    store.subscribe((s, prev) => view.update(s, prev));
    return { store, view };
  }

  const q = (sel: string) => host.querySelector<HTMLElement>(sel);
  const chip = () => q(".tl-chip")?.textContent;

  it("рендерить підписи, ромби, пройдену частину і плейхед", () => {
    const { view } = mountWith(fixture("crawling"));
    const labels = [...host.querySelectorAll(".tl-label")];
    expect(labels.map((l) => l.textContent)).toEqual([
      "01 Сайт",
      "02 Бренд-кіт",
      "03 Сценарій",
      "04 Сцени і музика",
      "05 Рендер",
      "06 Готово",
    ]);
    expect(labels[0]?.classList.contains("tl-label--active")).toBe(true);
    expect((labels[3] as HTMLElement).style.flex).toContain("1.6");
    expect(q(".tl-passed")?.style.width).toBe("8.529%");
    expect(q(".tl-playhead")?.style.left).toBe("8.529%");
    const diamonds = [...host.querySelectorAll<HTMLElement>(".tl-diamond")];
    expect(diamonds.map((d) => d.style.left)).toEqual(["34.328%", "52.239%", "76.119%"]);
    expect(diamonds.every((d) => d.classList.contains("diamond--lg"))).toBe(true);
    expect(diamonds.map((d) => d.dataset.state)).toEqual(["open", "open", "open"]);
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("update патчить на місці: ромб пульсує на awaiting_brand, ✓ у пройдених", () => {
    const { store, view } = mountWith(fixture("crawling"));
    const scale = q(".tl-scale");
    const firstLabel = q(".tl-label");
    store.setState(fixture("awaitingBrand"));
    expect(q(".tl-scale")).toBe(scale);
    expect(q(".tl-label")).toBe(firstLabel);
    expect(firstLabel?.textContent).toBe("✓ Сайт");
    expect(firstLabel?.classList.contains("tl-label--done")).toBe(true);
    const ring = q('.tl-diamond[data-checkpoint="brand"]');
    expect(ring?.classList.contains("diamond--ring")).toBe(true);
    expect(ring?.classList.contains("diamond--open")).toBe(true);
    expect(q(".tl-playhead")?.style.left).toBe("34.328%");
    view.destroy();
  });

  it("delivered: 100%, чип праворуч, ромби --ink", () => {
    const { view } = mountWith(fixture("delivered"));
    expect(q(".tl-playhead")?.style.left).toBe("100%");
    expect(q(".tl-playhead")?.classList.contains("tl-playhead--end")).toBe(true);
    expect(host.querySelectorAll(".tl-diamond.diamond--done").length).toBe(3);
    expect(chip()).toBe(formatMachineTime(fixture("delivered").busyMs));
    view.destroy();
  });

  it("чип тікає щосекунди лише в busy; destroy знімає інтервал", () => {
    vi.useFakeTimers();
    const s = fixture("crawling");
    const since = Date.parse(s.busySince as string);
    vi.setSystemTime(since + 4_200);
    const { view } = mountWith(s);
    expect(chip()).toBe("00:04");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TICK_MS);
    expect(chip()).toBe("00:05");
    vi.advanceTimersByTime(TICK_MS * 60);
    expect(chip()).toBe("01:05");
    view.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("вихід з busy зупиняє тікання, повернення — запускає знову", () => {
    vi.useFakeTimers();
    const s = fixture("crawling");
    vi.setSystemTime(Date.parse(s.busySince as string) + 1_000);
    const { store, view } = mountWith(s);
    expect(vi.getTimerCount()).toBe(1);
    store.setState(fixture("awaitingBrand"));
    expect(vi.getTimerCount()).toBe(0);
    expect(chip()).toBe(formatMachineTime(fixture("awaitingBrand").busyMs));
    vi.advanceTimersByTime(TICK_MS * 5);
    expect(chip()).toBe(formatMachineTime(fixture("awaitingBrand").busyMs));
    store.setState({ status: "scripting", busySince: new Date(Date.now()).toISOString() });
    expect(vi.getTimerCount()).toBe(1);
    // не плодить інтервали на кожен update
    store.setState({ progress: { stage: "storyboard", label: "Пишу сценарій…", done: null, total: null } });
    expect(vi.getTimerCount()).toBe(1);
    view.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("не busy — таймер не стартує", () => {
    vi.useFakeTimers();
    const { view } = mountWith(fixture("awaitingStoryboard"));
    expect(vi.getTimerCount()).toBe(0);
    view.destroy();
  });
});
