// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { storyboardPayload, storyboardPayloadRev2 } from "../../public/static/dev/fixture-events.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { ChatEvent, StoryboardCheckpointPayload, UiState } from "../../public/static/js/contracts.js";
import { reduce } from "../../public/static/js/data/reduce.js";
import { createStore } from "../../public/static/js/store.js";
import {
  boardFormats,
  boardPriceLine,
  formatClock,
  groupStills,
  isActive,
  issueHead,
  leadText,
  MUSIC_PENDING,
  mount,
  PREVIEW_FAILED,
  PREVIEW_PENDING,
  playedRatio,
  QA_OK,
  sceneAt,
  sceneLabel,
  sortWarnings,
  templateNote,
  WAVE_BARS,
  waveHeights,
} from "../../public/static/js/views/cp-board.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

function withPayload(state: UiState, payload: StoryboardCheckpointPayload, rev?: number): UiState {
  const entry = state.checkpoints.storyboard;
  if (!entry) throw new Error("немає чекпоінта storyboard");
  return {
    ...state,
    checkpoints: { ...state.checkpoints, storyboard: { ...entry, payload, rev: rev ?? entry.rev } },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  for (const fn of cleanups.splice(0)) fn();
  vi.restoreAllMocks();
  document.body.textContent = "";
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
  const $$ = (sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];
  const names = () => actions.calls.map((c) => c.name);
  return { el, store, actions, view, $, $$, names };
}

/** Мок медіа: play/pause шлють події, як браузер. */
function mockMedia() {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("pause"));
  });
  return { play, pause };
}

/** Ставить currentTime/duration екземпляру `<audio>` і шле подію. */
function tick(audio: HTMLAudioElement, current: number, duration: number, type = "timeupdate") {
  Object.defineProperty(audio, "currentTime", { configurable: true, get: () => current });
  Object.defineProperty(audio, "duration", { configurable: true, get: () => duration });
  audio.dispatchEvent(new Event(type));
}

describe("cp-board · шапка", () => {
  it("eyebrow з ромбом і ревізією, кнопки активні в awaiting_storyboard при open", () => {
    const { $ } = setup(fixture("awaitingStoryboard"));
    expect($(".cd-eyebrow")?.classList.contains("eyebrow")).toBe(true);
    expect($(".cd-eyebrow")?.textContent).toBe("Чекпоінт 3 / 3 · Розкадровка · ревізія 1");
    expect($(".cd-eyebrow .diamond.diamond--open")).not.toBeNull();
    const edit = $<HTMLButtonElement>(".cd-edit");
    const approve = $<HTMLButtonElement>(".cd-approve");
    expect(edit?.textContent).toBe("Правки");
    expect(edit?.classList.contains("btn--ghost")).toBe(true);
    expect(approve?.textContent).toBe("Затвердити й рендерити→");
    expect(approve?.classList.contains("btn--primary")).toBe(true);
    expect(edit?.disabled).toBe(false);
    expect(approve?.disabled).toBe(false);
  });

  it("«Затвердити й рендерити» → approve, «Правки» → startEdit", async () => {
    const { $, names, store } = setup(fixture("awaitingStoryboard"));
    $<HTMLButtonElement>(".cd-edit")?.click();
    expect(names()).toContain("startEdit");
    expect(store.getState().ui.editing).toBe(true);
    $<HTMLButtonElement>(".cd-approve")?.click();
    await vi.waitFor(() => expect(names()).toContain("approve"));
    expect(names().filter((n) => n === "approve")).toHaveLength(1);
  });

  it("поза awaiting_storyboard або коли чекпоінт не open — кнопки вимкнені й нічого не кличуть", () => {
    const base = fixture("awaitingStoryboard");
    const { $, names, store } = setup(base);
    const approve = $<HTMLButtonElement>(".cd-approve") as HTMLButtonElement;
    const edit = $<HTMLButtonElement>(".cd-edit") as HTMLButtonElement;

    store.setState({ status: "rendering" });
    expect(approve.disabled).toBe(true);
    expect(edit.disabled).toBe(true);
    approve.click();
    edit.click();
    expect(names()).toEqual([]);

    store.setState({ status: "awaiting_storyboard" });
    expect(approve.disabled).toBe(false);

    const entry = base.checkpoints.storyboard;
    if (!entry) throw new Error("немає чекпоінта");
    store.setState({ checkpoints: { ...base.checkpoints, storyboard: { ...entry, state: "approved" } } });
    expect(approve.disabled).toBe(true);
    expect(edit.disabled).toBe(true);
    expect($(".cd-eyebrow .diamond")?.classList.contains("diamond--done")).toBe(true);
    expect($(".cd-eyebrow .diamond")?.classList.contains("diamond--open")).toBe(false);
  });

  it("isActive", () => {
    const s = fixture("awaitingStoryboard");
    expect(isActive(s)).toBe(true);
    expect(isActive({ ...s, status: "directing" })).toBe(false);
    expect(isActive({ ...s, checkpoints: { ...s.checkpoints, storyboard: null } })).toBe(false);
  });
});

describe("cp-board · заголовок і стіли (S4)", () => {
  it("«Розкадровка» display-m і лід з основним форматом", () => {
    const { $ } = setup(fixture("awaitingStoryboard"));
    const title = $(".cd-title");
    expect(title?.tagName).toBe("H1");
    expect(title?.classList.contains("display-m")).toBe(true);
    expect(title?.textContent).toBe("Розкадровка");
    expect($(".cd-lead")?.textContent).toBe("Стіли в основному форматі 9:16 — по два кадри на сцену.");
    expect(leadText("landscape")).toContain("16:9");
    expect($(".cd-changed-note")).toBeNull();
  });

  it("стіли згруповані за сценою: a, b поруч, підпис «S1 · хук», розмір за форматом", () => {
    const { $$ } = setup(fixture("awaitingStoryboard"));
    const scenes = $$(".cd-scene");
    expect(scenes.map((s) => s.dataset.scene)).toEqual(["s1", "s2", "s3"]);
    for (const scene of scenes) {
      const imgs = [...scene.querySelectorAll<HTMLImageElement>("img.cd-still")];
      expect(imgs.map((i) => i.dataset.variant)).toEqual(["a", "b"]);
      expect(imgs.every((i) => i.getAttribute("height") === "230")).toBe(true);
      expect(imgs[0]?.getAttribute("src")).toBe(`/static/dev/media/still-${scene.dataset.scene}-a.svg`);
    }
    expect(scenes[0]?.querySelector(".cd-scene__label")?.textContent).toBe("S1 · хук");
    expect($$(".cd-tag--changed")).toHaveLength(0);
    expect($$(".cd-stills")[0]?.dataset.format).toBe("vertical");
  });

  it("groupStills: порядок сценарію, невідомі — за першою появою, a перед b", () => {
    const stills = [
      { sceneId: "x", variant: "b" as const, url: "/files/x-b.png" },
      { sceneId: "s2", variant: "b" as const, url: "/files/s2-b.png" },
      { sceneId: "s1", variant: "a" as const, url: "/files/s1-a.png" },
      { sceneId: "s2", variant: "a" as const, url: "/files/s2-a.png" },
      { sceneId: "x", variant: "a" as const, url: "/files/x-a.png" },
    ];
    const groups = groupStills(stills, ["s1", "s2", "s3"]);
    expect(groups.map((g) => g.sceneId)).toEqual(["s1", "s2", "x"]);
    expect(groups[1]?.stills.map((s) => s.variant)).toEqual(["a", "b"]);
    expect(groups[2]?.stills.map((s) => s.variant)).toEqual(["a", "b"]);
    expect(sceneLabel("s3", [{ id: "s3", purpose: "cta" }])).toBe("S1");
    expect(sceneLabel("x", [])).toBe("X");
  });

  it("changedScenes: позначка «змінено» лише на змінених, примітка під лідом", () => {
    const { $, $$ } = setup(withPayload(fixture("awaitingStoryboard"), storyboardPayloadRev2, 2));
    expect($(".cd-eyebrow")?.textContent).toContain("ревізія 2");
    const scenes = $$(".cd-scene");
    expect(scenes.map((s) => s.dataset.scene)).toEqual(["s1"]);
    expect(scenes[0]?.classList.contains("cd-scene--changed")).toBe(true);
    expect(scenes[0]?.querySelector(".cd-tag--changed")?.textContent).toBe("змінено");
    expect($(".cd-changed-note")?.textContent).toBe("Після правки змінено сцену S1; решта — без змін.");
  });

  it("changedScenes на синтетичному payload: позначено лише s2", () => {
    const payload: StoryboardCheckpointPayload = { ...storyboardPayload, changedScenes: ["s2"] };
    const { $$ } = setup(withPayload(fixture("awaitingStoryboard"), payload));
    const changed = $$(".cd-scene").filter((s) => s.querySelector(".cd-tag--changed"));
    expect(changed.map((s) => s.dataset.scene)).toEqual(["s2"]);
  });

  it("квадратний основний формат — висота 150; небезпечний URL не потрапляє в src", () => {
    const payload: StoryboardCheckpointPayload = {
      ...storyboardPayload,
      primaryFormat: "square",
      stills: [
        { sceneId: "s1", variant: "a", url: "/files/p/s1-a.png" },
        { sceneId: "s1", variant: "b", url: "javascript:alert(1)" },
      ],
    };
    const { $, $$ } = setup(withPayload(fixture("awaitingStoryboard"), payload));
    expect($(".cd-stills")?.dataset.format).toBe("square");
    expect($("img.cd-still")?.getAttribute("height")).toBe("150");
    expect($$("img.cd-still")).toHaveLength(1);
    expect($('.cd-still[data-variant="b"]')?.tagName).toBe("DIV");
    expect($(".cd-lead")?.textContent).toContain("1:1");
  });
});

describe("cp-board · аркуші", () => {
  it("рядок на формат, посилання на оригінал у новій вкладці з noopener noreferrer", () => {
    const payload: StoryboardCheckpointPayload = {
      ...storyboardPayload,
      sheets: [
        { format: "landscape", url: "/files/p/sheet-landscape.png" },
        { format: "square", url: "/files/p/sheet-square.png" },
        { format: "vertical", url: "data:image/png;base64,AAAA" },
      ],
    };
    const { $$ } = setup(withPayload(fixture("awaitingStoryboard"), payload));
    const rows = $$(".cd-sheet");
    expect(rows.map((r) => r.dataset.format)).toEqual(["square", "landscape"]);
    expect(rows.map((r) => r.querySelector(".cd-sheet__format")?.textContent)).toEqual(["1:1", "16:9"]);
    const link = rows[0]?.querySelector<HTMLAnchorElement>("a.cd-sheet__link");
    expect(link?.getAttribute("href")).toBe("/files/p/sheet-square.png");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.querySelector("img")?.getAttribute("src")).toBe("/files/p/sheet-square.png");
  });

  it("без аркушів рядка немає", () => {
    const { $ } = setup(withPayload(fixture("awaitingStoryboard"), { ...storyboardPayload, sheets: [] }));
    expect($(".cd-sheets")).toBeNull();
  });
});

describe("cp-board · перевірка (C7)", () => {
  it("рівні QA за C7: сортування, mono-шапка «S3 · 1:1 · серйозне · clipped_text», опис; fix лише в title", () => {
    const payload: StoryboardCheckpointPayload = {
      ...storyboardPayload,
      warnings: [
        ...storyboardPayload.warnings,
        {
          sceneId: "s1",
          format: "landscape",
          severity: "critical",
          kind: "empty_frame",
          description: "Порожній кадр.",
          fix: "Додати фото.",
        },
      ],
      templateScenes: ["s3"],
    };
    const { $, $$ } = setup(withPayload(fixture("awaitingStoryboard"), payload));
    const issues = $$(".cd-issue");
    expect(issues.map((i) => i.dataset.severity)).toEqual(["critical", "major", "minor"]);
    expect(issues.map((i) => i.querySelector(".cd-issue__head")?.textContent)).toEqual([
      "S1 · 16:9 · критичне · empty_frame",
      "S3 · 1:1 · серйозне · clipped_text",
      "S2 · 9:16 · незначне · outside_safe_area",
    ]);
    expect($$(".cd-issue .dot")).toHaveLength(0);
    const desc = issues[1]?.querySelector(".cd-issue__desc");
    expect(desc?.textContent).toBe("Адреса обрізана справа.");
    expect(desc?.getAttribute("title")).toBe(
      "Як виправити: Зменшити кегль адреси або перенести на два рядки.",
    );
    expect(issues.map((i) => i.textContent).join("")).not.toContain("Зменшити кегль");
    expect($(".cd-qa-ok")).toBeNull();
    expect($(".cd-note")?.textContent).toBe(
      "Сцени S3 не вдалося зібрати автоматично, тому вони зроблені за простим шаблоном.",
    );
    expect($('.cd-scene[data-scene="s3"] .cd-tag--template')).not.toBeNull();
  });

  it("порожні warnings — «✓ Перевірка не знайшла проблем», без templateScenes — без примітки", () => {
    const { $, $$ } = setup(
      withPayload(fixture("awaitingStoryboard"), { ...storyboardPayload, warnings: [] }),
    );
    expect($$(".cd-issue")).toHaveLength(0);
    expect($(".cd-qa-ok")?.textContent).toBe(QA_OK);
    expect($(".cd-note")).toBeNull();
  });

  it("templateNote, issueHead і sortWarnings", () => {
    expect(templateNote([])).toBeNull();
    expect(templateNote(["S2", "S3"])).toBe(
      "Сцени S2, S3 не вдалося зібрати автоматично, тому вони зроблені за простим шаблоном.",
    );
    const [minor, major] = storyboardPayload.warnings;
    if (!major || !minor) throw new Error("немає зауважень у фікстурі");
    expect(issueHead(minor, [])).toBe("S2 · 9:16 · незначне · outside_safe_area");
    expect(issueHead(major, [{ id: "s3", purpose: "cta" }])).toBe("S1 · 1:1 · серйозне · clipped_text");
    const sorted = sortWarnings(storyboardPayload.warnings);
    expect(sorted.map((w) => w.severity)).toEqual(["major", "minor"]);
  });
});

describe("cp-board · музика", () => {
  it("кнопка 44 px над прихованим <audio preload=metadata>, 72 смуги", () => {
    const { $, $$ } = setup(fixture("awaitingStoryboard"));
    const btn = $<HTMLButtonElement>(".cd-play");
    expect(btn?.classList.contains("btn-round")).toBe(true);
    expect(btn?.classList.contains("btn-round--44")).toBe(true);
    expect(btn?.querySelector(".icon-play")).not.toBeNull();
    const audio = $<HTMLAudioElement>("audio.cd-audio");
    expect(audio?.hasAttribute("hidden")).toBe(true);
    expect(audio?.getAttribute("preload")).toBe("metadata");
    expect(audio?.getAttribute("src")).toBe("/static/dev/media/sample.mp4");
    expect($$(".cd-wave__bar")).toHaveLength(WAVE_BARS);
    expect($(".cd-time")?.textContent).toBe("0:00 / 0:00");
  });

  it("play/pause: кнопка кличе медіа, іконка й заповнення смуг за подіями", () => {
    const { play, pause } = mockMedia();
    const { $, $$ } = setup(fixture("awaitingStoryboard"));
    const btn = $<HTMLButtonElement>(".cd-play") as HTMLButtonElement;
    const audio = $<HTMLAudioElement>("audio.cd-audio") as HTMLAudioElement;

    btn.click();
    expect(play).toHaveBeenCalledTimes(1);
    expect(btn.querySelector(".icon-pause")).not.toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    tick(audio, 7.4, 16);
    expect($(".cd-time")?.textContent).toBe("0:07 / 0:16");
    const played = $$(".cd-wave__bar.is-played").length;
    expect(played).toBe(Math.round((7.4 / 16) * WAVE_BARS));
    const bars = $$(".cd-wave__bar");
    expect(bars[0]?.classList.contains("is-played")).toBe(true);
    expect(bars[WAVE_BARS - 1]?.classList.contains("is-played")).toBe(false);

    btn.click();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(btn.querySelector(".icon-play")).not.toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    btn.click();
    expect(play).toHaveBeenCalledTimes(2);
    tick(audio, 16, 16, "ended");
    expect(btn.querySelector(".icon-play")).not.toBeNull();
    expect($$(".cd-wave__bar.is-played")).toHaveLength(WAVE_BARS);
  });

  it("loadedmetadata показує тривалість; destroy ставить на паузу й знімає слухачі", () => {
    const { pause } = mockMedia();
    const { $, view } = setup(fixture("awaitingStoryboard"));
    const audio = $<HTMLAudioElement>("audio.cd-audio") as HTMLAudioElement;
    const time = $(".cd-time") as HTMLElement;
    tick(audio, 0, 75.9, "loadedmetadata");
    expect(time.textContent).toBe("0:00 / 1:15");

    view.destroy();
    expect(pause).toHaveBeenCalled();
    tick(audio, 30, 75.9);
    expect(time.textContent).toBe("0:00 / 1:15");
  });

  it("music === null — «Музика ще генерується» замість плеєра", () => {
    const { $ } = setup(withPayload(fixture("awaitingStoryboard"), { ...storyboardPayload, music: null }));
    expect($("audio")).toBeNull();
    expect($(".cd-play")).toBeNull();
    expect($(".cd-music-pending")?.textContent).toBe(MUSIC_PENDING);
  });

  it("смуги детерміновані від URL", () => {
    const a = waveHeights("/files/p/music.mp3");
    expect(a).toHaveLength(WAVE_BARS);
    expect(waveHeights("/files/p/music.mp3")).toEqual(a);
    expect(waveHeights("/files/p/other.mp3")).not.toEqual(a);
    expect(a.every((v) => v >= 0.15 && v <= 1)).toBe(true);

    const first = setup(fixture("awaitingStoryboard"));
    const heights = first.$$(".cd-wave__bar").map((b) => b.style.getPropertyValue("--h"));
    const second = setup(fixture("awaitingStoryboard"));
    expect(second.$$(".cd-wave__bar").map((b) => b.style.getPropertyValue("--h"))).toEqual(heights);
  });

  it("formatClock і playedRatio", () => {
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(75)).toBe("1:15");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(playedRatio(4, 16)).toBe(0.25);
    expect(playedRatio(4, Number.NaN)).toBe(0);
    expect(playedRatio(20, 16)).toBe(1);
  });
});

describe("cp-board · update", () => {
  it("той самий payload (статус, ui, стан чекпоінта) — <audio> і <img> не перестворюються", () => {
    const base = fixture("awaitingStoryboard");
    const { $, store } = setup(base);
    const audio = $("audio");
    const img = $("img.cd-still");
    expect(audio).not.toBeNull();

    store.setState((s) => ({ ui: { ...s.ui, notice: "x" } }));
    store.setState({ status: "rendering" });
    const entry = base.checkpoints.storyboard;
    if (!entry) throw new Error("немає чекпоінта");
    store.setState({ checkpoints: { ...base.checkpoints, storyboard: { ...entry, state: "approved" } } });

    expect($("audio")).toBe(audio);
    expect($("img.cd-still")).toBe(img);
  });

  it("нова ревізія перебудовує вміст, а плеєр з тим самим URL переноситься", () => {
    const base = fixture("awaitingStoryboard");
    const { $, $$, store } = setup(base);
    const audio = $("audio");
    store.setState(withPayload(base, storyboardPayloadRev2, 2));
    expect($$(".cd-scene")).toHaveLength(1);
    expect($("audio")).toBe(audio);
    expect($$("audio")).toHaveLength(1);
    expect($(".cd-qa-ok")?.textContent).toBe(QA_OK);
  });

  it("нова ревізія з іншим URL музики — новий <audio>, старий на паузі", () => {
    const { pause } = mockMedia();
    const base = fixture("awaitingStoryboard");
    const { $, $$, store } = setup(base);
    const audio = $("audio");
    store.setState(withPayload(base, { ...storyboardPayload, music: { url: "/files/p/music-2.mp3" } }, 2));
    expect($$("audio")).toHaveLength(1);
    expect($("audio")).not.toBe(audio);
    expect($("audio")?.getAttribute("src")).toBe("/files/p/music-2.mp3");
    expect(pause).toHaveBeenCalled();
  });
});

describe("cp-board · безпека", () => {
  it("без HTML-рядків, eval та інлайнових on*-атрибутів", () => {
    const src = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "static/js/views/cp-board.js"), "utf8");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
    expect(src).not.toMatch(/setAttribute\(\s*["']on/);
  });
});

// ───────────── B5 · ціни на ЧП3 (N5-A) ─────────────

const NB = " ";

describe("cp-board · ціни (N5-A)", () => {
  function priced(name: string) {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("мережа в тесті"))),
    );
    return setup(fixture(name));
  }
  const lineText = (root: HTMLElement | null) => root?.firstElementChild?.textContent ?? null;

  it("n5-cp3: сума в «Затвердити й рендерити» і рядок «2 кредити за 1:1»", () => {
    const { $ } = priced("n5-cp3");
    expect($(".cd-approve__price")?.hidden).toBe(false);
    expect($(".cd-approve")?.textContent).toBe(`Затвердити й рендерити2${NB}кредити→`);
    expect($(".cd-price")?.hidden).toBe(false);
    expect(lineText($(".cd-price"))).toBe(`2${NB}кредити за 1:1`);
    expect($(".cd-price__topup")?.hidden).toBe(true);
    // Рядок — одразу під шапкою.
    expect($(".cd-head")?.nextElementSibling).toBe($(".cd-price"));
  });

  it("n5-cp3-short: «· у вас 1 · поповнити» → openTopup(ws, cp3); затвердження не блокується", async () => {
    const { $, actions, names } = priced("n5-cp3-short");
    expect(lineText($(".cd-price"))).toBe(`2${NB}кредити за 1:1 · у вас 1`);
    const topup = $<HTMLButtonElement>(".cd-price__topup");
    expect(topup?.hidden).toBe(false);
    topup?.click();
    expect(actions.calls.find((c) => c.name === "openTopup")?.args).toEqual([{ from: "ws", ctx: "cp3" }]);
    const approve = $<HTMLButtonElement>(".cd-approve");
    expect(approve?.disabled).toBe(false);
    approve?.click();
    await Promise.resolve();
    expect(names()).toContain("approve");
  });

  it("n5-cp3-paid: оплачений 1:1 не рахується — «1:1 оплачено раніше · 2 кредити за 16:9»", () => {
    const { $ } = priced("n5-cp3-paid");
    expect($(".cd-eyebrow__text")?.textContent).toBe("Чекпоінт 3 / 3 · Розкадровка · ревізія 2");
    expect($(".cd-approve__price")?.textContent).toBe(`2${NB}кредити`);
    expect(lineText($(".cd-price"))).toBe(`1:1 оплачено раніше · 2${NB}кредити за 16:9`);
  });

  it("n5-cp3-one: один формат — без суми й без рядка", () => {
    const { $ } = priced("n5-cp3-one");
    expect($(".cd-approve__price")?.hidden).toBe(true);
    expect($(".cd-price")?.hidden).toBe(true);
  });

  it("поповнення і «Лишити один формат» (pendingFormats) оновлюють суму без перебудови", () => {
    const { $, store } = priced("n5-cp3-short");
    const approve = $(".cd-approve");
    store.setState((s) => ({
      account: { ...s.account, me: s.account.me && { ...s.account.me, balance: 11 } },
    }));
    expect(lineText($(".cd-price"))).toBe(`2${NB}кредити за 1:1`);
    expect($(".cd-price__topup")?.hidden).toBe(true);
    store.setState((s) => ({ ui: { ...s.ui, pendingFormats: ["vertical"] } }));
    expect($(".cd-approve__price")?.hidden).toBe(true);
    expect($(".cd-price")?.hidden).toBe(true);
    expect($(".cd-approve")).toBe(approve);
  });

  it("без цін (account.prices = null) — нічого не підписано", () => {
    const base = fixture("n5-cp3");
    const { $ } = setup({ ...base, account: { ...base.account, prices: null } });
    expect($(".cd-approve__price")?.hidden).toBe(true);
    expect($(".cd-price")?.hidden).toBe(true);
  });

  it("boardFormats / boardPriceLine", () => {
    const base = fixture("n5-cp3-paid");
    expect(boardFormats(base)).toEqual(["vertical", "square", "landscape"]);
    expect(boardFormats({ ...base, ui: { ...base.ui, pendingFormats: ["landscape", "vertical"] } })).toEqual([
      "vertical",
      "landscape",
    ]);
    expect(boardFormats({ ...base, checkpoints: { ...base.checkpoints, storyboard: null } })).toEqual([]);
    expect(boardPriceLine({ need: 0, extra: [], paid: [], balance: 12, short: false })).toBeNull();
    expect(boardPriceLine({ need: 0, extra: [], paid: ["square"], balance: 12, short: false })).toBe(
      "1:1 оплачено раніше",
    );
    expect(
      boardPriceLine({ need: 4, extra: ["square", "landscape"], paid: [], balance: 1, short: true }),
    ).toBe(`4${NB}кредити за 1:1, 16:9 · у вас 1`);
  });
});

// ───────────── B4 · відео-превʼю ЧП3 ─────────────

describe("cp-board · відео-превʼю", () => {
  const READY_URL = "/static/media/sample-9x16.mp4";

  function previewFixture(name: string) {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("мережа в тесті"))),
    );
    return setup(fixture(name));
  }

  /** Керований `currentTime` екземпляра медіа (з сеттером — перемотування з коду). */
  function clock(media: HTMLMediaElement) {
    let t = 0;
    Object.defineProperty(media, "currentTime", {
      configurable: true,
      get: () => t,
      set: (v: number) => {
        t = v;
      },
    });
    return {
      get now() {
        return t;
      },
      at(sec: number, type = "timeupdate") {
        t = sec;
        media.dispatchEvent(new Event(type));
      },
    };
  }

  /** Подія `preview` через редьюсер — як зі стріму. */
  function applyPreview(store: ReturnType<typeof setup>["store"], event: Record<string, unknown>) {
    const ev = { type: "preview", at: "2026-10-06T10:05:00.000Z", ...event } as ChatEvent;
    store.setState(reduce(store.getState(), ev, "9000-0"));
  }

  function timelineOf(state: UiState) {
    const p = state.checkpoints.storyboard?.payload as StoryboardCheckpointPayload;
    return p.timeline ?? [];
  }

  const playing = ($$: (sel: string) => HTMLElement[]) =>
    $$(".cd-scene.cd-scene--playing").map((li) => li.dataset.scene);

  it("pending: рядок «Превʼю» між вступом і стілами — смугаста заглушка у форматі й текст", () => {
    const { $, $$ } = previewFixture("n5-cp3-preview-pending");
    const row = $(".cd-preview") as HTMLElement;
    expect(row.classList.contains("spec-row")).toBe(true);
    expect(row.querySelector(".spec-row__label")?.textContent).toBe("Превʼю");
    expect(row.previousElementSibling?.classList.contains("cd-intro")).toBe(true);
    expect(row.nextElementSibling?.classList.contains("cd-stills")).toBe(true);
    const frame = row.querySelector(".cd-preview__frame") as HTMLElement;
    expect(frame.classList.contains("stripes")).toBe(true);
    expect(frame.dataset.format).toBe("vertical");
    expect(row.querySelector(".cd-preview-note")?.textContent).toBe(PREVIEW_PENDING);
    expect(PREVIEW_PENDING).toBe("Відео-превʼю рендериться — зазвичай 1–2 хв. Затвердити можна, не чекаючи.");
    expect($("video")).toBeNull();
    expect($$(".cd-scene__play")).toHaveLength(0);
  });

  it("ready: <video controls playsinline preload=metadata> з URL превʼю і кнопки «▶ Сцена»", () => {
    const { $, $$ } = previewFixture("n5-cp3-preview-ready");
    const video = $<HTMLVideoElement>(".cd-preview video.cd-video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(READY_URL);
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.dataset.format).toBe("vertical");
    expect($(".cd-preview__frame")).toBeNull();

    const buttons = $$(".cd-scene__play");
    expect(buttons.map((b) => b.closest(".cd-scene")?.getAttribute("data-scene"))).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    expect(buttons.map((b) => b.textContent)).toEqual(["▶ Сцена", "▶ Сцена", "▶ Сцена"]);
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Програти сцену 1",
      "Програти сцену 2",
      "Програти сцену 3",
    ]);
    expect(buttons.every((b) => b.getAttribute("type") === "button")).toBe(true);
  });

  it("failed: текст замість плеєра, без кнопок сцен", () => {
    const { $, $$ } = previewFixture("n5-cp3-preview-failed");
    expect($(".cd-preview .cd-preview-note")?.textContent).toBe(PREVIEW_FAILED);
    expect(PREVIEW_FAILED).toBe(
      "Превʼю не вдалося зібрати. Розкадровку можна затвердити — фінальне відео зрендериться як завжди.",
    );
    expect($("video")).toBeNull();
    expect($$(".cd-scene__play")).toHaveLength(0);
  });

  it("небезпечний URL не потрапляє в src — як failed", () => {
    const base = fixture("n5-cp3-preview-ready");
    const entry = base.checkpoints.storyboard;
    if (!entry?.preview) throw new Error("немає превʼю у фікстурі");
    const { $, $$ } = setup({
      ...base,
      checkpoints: {
        ...base.checkpoints,
        storyboard: { ...entry, preview: { ...entry.preview, url: "javascript:alert(1)" } },
      },
    });
    expect($("video")).toBeNull();
    expect($$(".cd-scene__play")).toHaveLength(0);
    expect($(".cd-preview .cd-preview-note")?.textContent).toBe(PREVIEW_FAILED);
  });

  it("стара подія (без preview/timeline) — ні рядка, ні кнопок; ready без timeline — без кнопок", () => {
    const { $, $$ } = setup(fixture("awaitingStoryboard"));
    expect($(".cd-preview")).toBeNull();
    expect($$(".cd-scene__play")).toHaveLength(0);
    document.body.textContent = "";

    const base = fixture("n5-cp3-preview-ready");
    const payload = base.checkpoints.storyboard?.payload as StoryboardCheckpointPayload;
    const noTimeline = setup(withPayload(base, { ...payload, timeline: [] }));
    expect(noTimeline.$("video")).not.toBeNull();
    expect(noTimeline.$$(".cd-scene__play")).toHaveLength(0);
  });

  it("«▶ Сцена»: перемотка на початок, play, пауза на кінці сцени (допуск ~1 кадр)", () => {
    const { play, pause } = mockMedia();
    const { $, $$ } = previewFixture("n5-cp3-preview-ready");
    const video = $<HTMLVideoElement>("video") as HTMLVideoElement;
    const t = clock(video);
    const s2 = timelineOf(fixture("n5-cp3-preview-ready"))[1];
    if (!s2) throw new Error("немає сцени 2 у таймінгу");

    ($$(".cd-scene__play")[1] as HTMLButtonElement).click();
    expect(t.now).toBeCloseTo(s2.fromMs / 1000);
    expect(play).toHaveBeenCalledTimes(1);

    const end = (s2.fromMs + s2.durationMs) / 1000;
    t.at(end - 0.2);
    expect(pause).not.toHaveBeenCalled();
    t.at(end - 0.01);
    expect(pause).toHaveBeenCalledTimes(1);

    // Далі відтворення вільне: без сцени — без зупинки.
    video.dispatchEvent(new Event("play"));
    t.at(end + 0.5);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("кінець сцени перевіряється щокадру (requestAnimationFrame), не чекаючи timeupdate", () => {
    const { pause } = mockMedia();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const flush = () => {
      for (const cb of frames.splice(0)) cb(0);
    };
    const { $, $$ } = previewFixture("n5-cp3-preview-ready");
    const video = $<HTMLVideoElement>("video") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    const t = clock(video);
    const s1 = timelineOf(fixture("n5-cp3-preview-ready"))[0];
    if (!s1) throw new Error("немає сцени 1 у таймінгу");

    ($$(".cd-scene__play")[0] as HTMLButtonElement).click();
    flush();
    expect(pause).not.toHaveBeenCalled();
    expect(frames.length).toBeGreaterThan(0);
    t.at((s1.fromMs + s1.durationMs) / 1000 - 0.01, "progress");
    flush();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });

  it("перемотка поза сцену скасовує зупинку на її кінці", () => {
    const { pause } = mockMedia();
    const { $, $$ } = previewFixture("n5-cp3-preview-ready");
    const video = $<HTMLVideoElement>("video") as HTMLVideoElement;
    const t = clock(video);
    const s1 = timelineOf(fixture("n5-cp3-preview-ready"))[0];
    if (!s1) throw new Error("немає сцени 1 у таймінгу");

    ($$(".cd-scene__play")[0] as HTMLButtonElement).click();
    t.at(4, "seeked");
    t.at(4.2);
    expect(pause).not.toHaveBeenCalled();
  });

  it("підсвітка cd-scene--playing за currentTime; при перекритті — пізніша сцена; пауза знімає", () => {
    mockMedia();
    const { $, $$ } = previewFixture("n5-cp3-preview-ready");
    const video = $<HTMLVideoElement>("video") as HTMLVideoElement;
    const t = clock(video);
    expect(playing($$)).toEqual([]);

    video.dispatchEvent(new Event("play"));
    t.at(0.5);
    expect(playing($$)).toEqual(["s1"]);
    t.at(1.7); // s1 (0–1.8) і s2 (1.6–3.4) перекриваються
    expect(playing($$)).toEqual(["s2"]);
    t.at(4.2);
    expect(playing($$)).toEqual(["s3"]);
    video.dispatchEvent(new Event("pause"));
    expect(playing($$)).toEqual([]);
    t.at(0.5);
    expect(playing($$)).toEqual([]);
  });

  it("sceneAt: кінець сцени не входить, перекриття — пізніша", () => {
    const tl = [
      { sceneId: "s1", fromMs: 0, durationMs: 5000 },
      { sceneId: "s2", fromMs: 4500, durationMs: 5500 },
    ];
    expect(sceneAt(tl, 0)).toBe("s1");
    expect(sceneAt(tl, 4600)).toBe("s2");
    expect(sceneAt(tl, 9999)).toBe("s2");
    expect(sceneAt(tl, 10000)).toBeNull();
    expect(sceneAt([], 10)).toBeNull();
  });

  it("взаємовиключення: play відео → пауза музики; play музики → пауза відео", () => {
    const { play, pause } = mockMedia();
    const { $ } = previewFixture("n5-cp3-preview-ready");
    const video = $<HTMLVideoElement>("video") as HTMLVideoElement;
    const audio = $<HTMLAudioElement>("audio") as HTMLAudioElement;
    const musicBtn = $<HTMLButtonElement>(".cd-play") as HTMLButtonElement;

    musicBtn.click();
    expect(play.mock.contexts.at(-1)).toBe(audio);
    video.dispatchEvent(new Event("play"));
    expect(pause.mock.contexts).toEqual([audio]);
    expect(musicBtn.getAttribute("aria-pressed")).toBe("false");

    musicBtn.click();
    expect(pause.mock.contexts).toEqual([audio, video]);
  });

  it("подія preview оновлює лише рядок і кнопки: стіли й <audio> не перестворюються, музика не обривається", () => {
    const { pause } = mockMedia();
    const { $, $$, store } = previewFixture("n5-cp3-preview-pending");
    const audio = $("audio") as HTMLAudioElement;
    const img = $("img.cd-still");
    ($(".cd-play") as HTMLButtonElement).click();
    const rev = store.getState().checkpoints.storyboard?.rev;

    applyPreview(store, { rev, format: "vertical", state: "ready", url: READY_URL });
    expect($("audio")).toBe(audio);
    expect($("img.cd-still")).toBe(img);
    expect(pause).not.toHaveBeenCalled();
    const video = $("video");
    expect(video?.getAttribute("src")).toBe(READY_URL);
    expect($(".cd-preview__frame")).toBeNull();
    expect($$(".cd-scene__play")).toHaveLength(3);

    // Повтор події і зміни поза превʼю — той самий <video>.
    applyPreview(store, { rev, format: "vertical", state: "ready", url: READY_URL });
    store.setState({ status: "rendering" });
    expect($("video")).toBe(video);
    expect($$(".cd-scene__play")).toHaveLength(3);
  });

  it("pending → failed без перебудови; подія чужої ревізії нічого не міняє", () => {
    const { $, store } = previewFixture("n5-cp3-preview-pending");
    const img = $("img.cd-still");
    const rev = store.getState().checkpoints.storyboard?.rev ?? 0;
    applyPreview(store, { rev: rev - 1, format: "vertical", state: "ready", url: READY_URL });
    expect($(".cd-preview__frame")).not.toBeNull();
    applyPreview(store, { rev, format: "vertical", state: "failed", url: null });
    expect($(".cd-preview .cd-preview-note")?.textContent).toBe(PREVIEW_FAILED);
    expect($("img.cd-still")).toBe(img);
  });

  it("destroy ставить відео на паузу й знімає слухачі", () => {
    const { pause } = mockMedia();
    const { $, $$, view } = previewFixture("n5-cp3-preview-ready");
    const video = $<HTMLVideoElement>("video") as HTMLVideoElement;
    const t = clock(video);
    const scenes = $$(".cd-scene");
    view.destroy();
    expect(pause.mock.contexts).toContain(video);
    video.dispatchEvent(new Event("play"));
    t.at(0.5);
    expect(scenes.some((li) => li.classList.contains("cd-scene--playing"))).toBe(false);
  });
});
