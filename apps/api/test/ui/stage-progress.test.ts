// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { segments } from "../../public/static/dev/fixture-events.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { STAGE_STEPS, type UiState } from "../../public/static/js/contracts.js";
import { reduce, reduceAll } from "../../public/static/js/data/reduce.js";
import { initialState } from "../../public/static/js/initial.js";
import { createStore } from "../../public/static/js/store.js";
import * as failed from "../../public/static/js/views/failed.js";
import * as sp from "../../public/static/js/views/stage-progress.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

const STATIC_DIR = path.join(DEFAULT_PUBLIC_DIR, "static");

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

type StoredEvent = (typeof segments.toStoryboard)[number];

/** Стан після подій сегмента до першої (включно), що задовольняє `pred`. */
function playUntil(base: UiState, events: StoredEvent[], pred: (e: StoredEvent["event"]) => boolean) {
  const i = events.findIndex((e) => pred(e.event));
  if (i < 0) throw new Error("подію не знайдено");
  return reduceAll(base, events.slice(0, i + 1));
}

const byLabel = (label: string) => (e: StoredEvent["event"]) => e.type === "progress" && e.label === label;

let seq = 0;
/** Подія progress через справжній редьюсер; `dt` — секунд після останньої події стану. */
function progress(
  s: UiState,
  stage: string,
  label: string,
  done: number | null = null,
  total: number | null = null,
  step?: string,
  dt = 1,
) {
  seq += 1;
  // Час — після останньої події стану (фікстура має власний годинник, не Date.now()).
  const last = Math.max(0, ...s.feed.map((i) => Date.parse(i.at)), s.busySince ? Date.parse(s.busySince) : 0);
  return reduce(
    s,
    {
      type: "progress",
      // biome-ignore lint/suspicious/noExplicitAny: stage — CostStage, у тесті довільний рядок зі схеми
      stage: stage as any,
      label,
      done,
      total,
      ...(step ? { step } : {}),
      at: new Date(last + dt * 1000).toISOString(),
    },
    `t-${seq}`,
  );
}

/** Той самий стан без `step` у рядках стрічки — як старі події. */
const withoutSteps = (s: UiState): UiState => ({
  ...s,
  feed: s.feed.map((i) => {
    if (i.kind !== "progress") return i;
    const { step: _step, ...rest } = i;
    return rest;
  }),
});

/** Початок стану scripting без жодної події progress. */
const scriptingStart = (): UiState => ({
  ...fixture("brandkit"),
  status: "scripting",
  stageLog: [],
  progress: null,
});

describe("views/stage-progress.js", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    document.body.textContent = "";
  });

  function mountWith(state: UiState, mount = sp.mount) {
    const store = createStore(state);
    const actions = createDevActions(store);
    const view = mount(host, { store, actions });
    store.subscribe((s, prev) => view.update(s, prev));
    return { store, actions, view };
  }

  const q = (sel: string) => host.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
  const barValue = (el: HTMLElement | null) => Number(el?.style.getPropertyValue("--bar-value"));

  it("intake: eyebrow «01 — Сайт», заголовок з пульсуючою крапкою, хост і рядок очікування", () => {
    const { view } = mountWith({ ...initialState("project", "p1"), site: "zerno.example.com" });
    expect(q(".sp")?.dataset.status).toBe("intake");
    expect(q(".sp-eyebrow")?.textContent).toBe("01 — Сайт");
    expect(q(".sp-eyebrow")?.classList.contains("eyebrow")).toBe(true);
    const title = q("h1.sp-title");
    expect(title?.classList.contains("display-l")).toBe(true);
    expect(q(".sp-title__text")?.textContent).toBe("Приймаю проєкт");
    const dot = q("h1 .sp-pulse");
    expect(dot?.classList.contains("accent-dot")).toBe(true);
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(q(".sp-host")?.textContent).toBe("zerno.example.com");
    expect(q(".sp-host")?.classList.contains("display-m")).toBe(true);
    expect(qa(".sp-log__row")).toHaveLength(1);
    expect(q(".sp-log__row .spinner")).not.toBeNull();
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("crawling (X5): хост display-m, numeral done/total, смуга, мітка", () => {
    const { view } = mountWith(fixture("crawling"));
    expect(q(".sp-eyebrow")?.textContent).toBe("01 — Сайт");
    const title = q("h1.sp-title");
    expect(title?.classList.contains("display-m")).toBe(true);
    expect(title?.classList.contains("display-l")).toBe(false);
    expect(q(".sp-title__text")?.textContent).toBe("zerno.example.com");
    expect(q("h1 .sp-pulse")).not.toBeNull();
    const numeral = q(".sp-numeral");
    expect(numeral?.classList.contains("numeral")).toBe(true);
    expect(numeral?.textContent).toBe("4/7");
    expect(q(".sp-numeral .numeral__unit")?.textContent).toBe("/7");
    expect(barValue(q(".sp-bar"))).toBeCloseTo(4 / 7);
    expect(q(".sp-bar")?.classList.contains("bar")).toBe(true);
    expect(q(".sp-bar .bar__fill")).not.toBeNull();
    expect(q(".sp-caption")?.textContent).toBe("Сканую сайт… 4/7 сторінок · ліміт 120 с");
    view.destroy();
  });

  it("crawling без done/total: невідома смуга, без одиниці", () => {
    const { store, view } = mountWith(fixture("crawling"));
    store.setState({ progress: { stage: "crawl", label: "Сканую сайт…", done: null, total: null } });
    expect(q(".sp-numeral .numeral__unit")?.hidden).toBe(true);
    expect(q(".sp-bar")?.classList.contains("sp-bar--unknown")).toBe(true);
    view.destroy();
  });

  it("update не перестворює вузли при зміні лічильника", () => {
    const { store, view } = mountWith(fixture("crawling"));
    const root = q(".sp");
    const numeral = q(".sp-numeral");
    const bar = q(".sp-bar");
    const caption = q(".sp-caption");
    const title = q("h1");
    store.setState((s) => progress(s, "crawl", "Сканую сайт… 5/7 сторінок", 5, 7));
    expect(q(".sp")).toBe(root);
    expect(q(".sp-numeral")).toBe(numeral);
    expect(q(".sp-bar")).toBe(bar);
    expect(q(".sp-caption")).toBe(caption);
    expect(q("h1")).toBe(title);
    expect(numeral?.textContent).toBe("5/7");
    expect(barValue(bar)).toBeCloseTo(5 / 7);
    expect(caption?.textContent).toContain("5/7 сторінок");
    view.destroy();
  });

  /** Чекліст: [step, state, мітка праворуч] кожного рядка (у межах `root`). */
  const steps = (root: ParentNode = host) =>
    [...root.querySelectorAll<HTMLElement>(".sp-step")].map((li) => [
      li.dataset.step,
      li.dataset.state,
      li.querySelector(".sp-step__meta")?.textContent,
    ]);
  const labels = (root: ParentNode = host) =>
    [...root.querySelectorAll(".sp-step__label")].map((l) => l.textContent);

  it("crawling: чекліст підкроків під лічильником — «Сканую сторінки» 4/7", () => {
    const { view } = mountWith(fixture("crawling"));
    expect(labels()).toEqual([
      "Відкриваю сайт",
      "Сканую сторінки",
      "Завантажую фото й шрифти",
      "Обробляю фото",
    ]);
    // «Відкриваю сайт» перестрибнули (події open немає) — ✓ без часу.
    expect(steps()).toEqual([
      ["open", "done", ""],
      ["pages", "active", "4/7"],
      ["assets", "pending", ""],
      ["photos", "pending", ""],
    ]);
    view.destroy();
  });

  it("brandkit: eyebrow «02 — Бренд-кіт», чекліст із 4 кроків, перший зі спінером", () => {
    const { view } = mountWith(fixture("brandkit"));
    expect(q(".sp-eyebrow")?.textContent).toBe("02 — Бренд-кіт");
    expect(q(".sp-title__text")?.textContent).toBe("Збираю бренд-кіт");
    expect(labels()).toEqual([
      "Читаю тексти сайту",
      "Роздивляюсь фото й скриншоти",
      "Складаю бренд-кіт",
      "Звіряю факти, кольори й шрифти",
    ]);
    expect(steps().map((r) => r[1])).toEqual(["active", "pending", "pending", "pending"]);
    expect(qa(".sp-step")[0]?.querySelector(".spinner")).not.toBeNull();
    expect(q(".sp-log")).toBeNull();
    view.destroy();
  });

  describe("scripting — чекліст підкроків", () => {
    it("фікстура scripting (= ?jump=scripting): 2 ✓, «Підганяю тексти» зі спінером, «Звіряю цифри» сіре", () => {
      const { view } = mountWith(fixture("scripting"));
      expect(q(".sp-eyebrow")?.textContent).toBe("03 — Сценарій");
      expect(q(".sp-title__text")?.textContent).toBe("Пишу сценарій");
      expect(labels()).toEqual([
        "Читаю бренд-кіт і сайт",
        "Пишу концепт і сцени",
        "Підганяю тексти під екран",
        "Звіряю цифри з сайтом",
      ]);
      // Змонтовано посеред стадії: моменти старту кроків не бачили — ✓ без часу.
      expect(steps()).toEqual([
        ["brief", "done", ""],
        ["write", "done", ""],
        ["fit", "active", ""],
        ["claims", "pending", ""],
      ]);
      const [brief, , fit, claims] = qa(".sp-step");
      expect(brief?.querySelector(".sp-step__mark")?.textContent).toBe("✓");
      expect(fit?.querySelector(".spinner")).not.toBeNull();
      expect(claims?.querySelector(".spinner")).toBeNull();
      expect(claims?.querySelector(".sp-step__mark")?.textContent).toBe("");
      view.destroy();
    });

    it("на кожному етапі фікстури — правильні стани 4 кроків", () => {
      const base = fixture("awaitingBrand");
      const events = segments.toScript;
      const at = (step: string) =>
        sp
          .stageRows(
            STAGE_STEPS.scripting,
            playUntil(base, events, (e) => e.type === "progress" && e.step === step),
          )
          .map((r) => r.state);
      expect(at("brief")).toEqual(["active", "pending", "pending", "pending"]);
      expect(at("write")).toEqual(["done", "active", "pending", "pending"]);
      expect(at("fit")).toEqual(["done", "done", "active", "pending"]);
      expect(at("claims")).toEqual(["done", "done", "done", "active"]);
    });

    it("наживо: ✓ з тривалістю (різниця at), спінер з лічильником, вузли рядків ті самі", () => {
      const { store, view } = mountWith(scriptingStart());
      // До першої події — перший крок неявно активний, решта сірі.
      expect(steps()).toEqual([
        ["brief", "active", ""],
        ["write", "pending", ""],
        ["fit", "pending", ""],
        ["claims", "pending", ""],
      ]);
      const nodes = qa(".sp-step");
      const body = q(".sp-body");
      store.setState((s) => progress(s, "storyboard", "Пишу сценарій…", null, null, "brief"));
      store.setState((s) => progress(s, "storyboard", "Пишу концепт і сцени…", null, null, "write", 12));
      store.setState((s) => progress(s, "storyboard", "Підганяю тексти під екран… 1/3", 1, 3, "fit", 75));
      expect(steps()).toEqual([
        ["brief", "done", "12 с"],
        ["write", "done", "1 хв 15 с"],
        ["fit", "active", "1/3"],
        ["claims", "pending", ""],
      ]);
      store.setState((s) => progress(s, "storyboard", "Підганяю тексти під екран… 2/3", 2, 3, "fit", 2));
      expect(steps()[2]).toEqual(["fit", "active", "2/3"]);
      expect(qa(".sp-step")).toEqual(nodes);
      expect(q(".sp-body")).toBe(body);
      view.destroy();
    });

    it("крок, на який перестрибнули, — ✓ без часу", () => {
      const { store, view } = mountWith(scriptingStart());
      store.setState((s) => progress(s, "storyboard", "Пишу сценарій…", null, null, "brief"));
      store.setState((s) => progress(s, "storyboard", "Звіряю цифри з сайтом…", null, null, "claims", 20));
      expect(steps()).toEqual([
        ["brief", "done", "20 с"],
        ["write", "done", ""],
        ["fit", "done", ""],
        ["claims", "active", ""],
      ]);
      view.destroy();
    });

    it("старі події без step: крок за stage, UI не порожній", () => {
      const { store, view } = mountWith(withoutSteps(fixture("scripting")));
      // Усі рядки storyboard злиті в один, без step → «Читаю бренд-кіт і сайт» (stages: storyboard).
      expect(steps().map((r) => r[1])).toEqual(["active", "pending", "pending", "pending"]);
      store.setState((s) => progress(s, "storyboard", "Пишу сценарій…"));
      expect(qa(".sp-step")).toHaveLength(4);
      expect(steps()[0]?.[1]).toBe("active");
      view.destroy();
    });

    it("злиті рядки стрічки: пройдені кроки — з того, що чекліст бачив наживо", () => {
      const s = fixture("scripting");
      expect(s.feed.filter((i) => i.kind === "progress" && i.stage === "storyboard")).toHaveLength(1);
      expect([...sp.visitedSteps(STAGE_STEPS.scripting, s, [])]).toEqual(["fit"]);
      expect([...sp.visitedSteps(STAGE_STEPS.scripting, s, ["brief", "write"])]).toEqual([
        "brief",
        "write",
        "fit",
      ]);
    });
  });

  it("зміна статусу на brandkit/scripting: чекліст нового статусу без часу зі старого", () => {
    const { store, view } = mountWith(fixture("crawling"));
    store.setState((s) =>
      reduce(
        s,
        { type: "state", status: "brandkit", prev: "crawling", rev: 1, at: "2026-10-06T10:00:10.000Z" },
        "st-1",
      ),
    );
    expect(steps().map((r) => r[0])).toEqual(["read", "look", "compose", "verify"]);
    expect(steps()[0]?.[1]).toBe("active");
    view.destroy();
  });

  it("зміна статусу перебудовує лише тіло, корінь лишається", () => {
    const { store, view } = mountWith(fixture("brandkit"));
    const root = q(".sp");
    const body = q(".sp-body");
    store.setState({ status: "scripting", stageLog: [], progress: null });
    expect(q(".sp")).toBe(root);
    expect(q(".sp-body")).not.toBe(body);
    expect(q(".sp")?.dataset.status).toBe("scripting");
    expect(q(".sp-eyebrow")?.textContent).toBe("03 — Сценарій");
    view.destroy();
  });

  describe("directing — дві гілки", () => {
    const branch = (key: string) => q(`.sp-branch[data-branch="${key}"]`);
    const status = (key: string) => branch(key)?.querySelector(".sp-branch__status")?.textContent;
    const bar = (key: string) => branch(key)?.querySelector<HTMLElement>(".sp-bar") ?? null;
    const branchSteps = (key: string) => steps(branch(key) ?? host);
    const shared = () => steps(q(".sp-shared") ?? host);

    it("фікстура: сцени 2/3, музика пишеться; чекліст кожної гілки і спільні кроки нижче", () => {
      const { view } = mountWith(fixture("directing"));
      expect(q(".sp-eyebrow")?.textContent).toBe("04 — Сцени і музика");
      expect(q(".sp-title__text")?.textContent).toBe("Генерую сцени і музику");
      expect(branch("scenes")?.querySelector("h2")?.textContent).toBe("Сцени");
      expect(branch("music")?.querySelector("h2")?.textContent).toBe("Музика");
      expect(branch("scenes")?.dataset.state).toBe("running");
      expect(status("scenes")).toBe("2/3");
      expect(barValue(bar("scenes"))).toBeCloseTo(2 / 3);
      expect(labels(branch("scenes") ?? host)).toEqual([
        "Пишу анімацію сцен",
        "Перевіряю код сцен",
        "Знімаю кадри",
        "Перевіряю кадри",
      ]);
      // «Виправляю сцени» (optional) не почався — не показується.
      expect(branchSteps("scenes")).toEqual([
        ["code", "active", "2/3"],
        ["check", "pending", ""],
        ["stills", "pending", ""],
        ["qa", "pending", ""],
      ]);
      expect(branch("music")?.dataset.state).toBe("running");
      expect(branchSteps("music")).toEqual([["music", "active", ""]]);
      expect(bar("music")?.classList.contains("sp-bar--unknown")).toBe(true);
      expect(q(".sp-shared h2")?.textContent).toBe("Звук і рецензія");
      expect(shared()).toEqual([
        ["sfx", "pending", ""],
        ["review", "pending", ""],
      ]);
      view.destroy();
    });

    it("музика «готово» після progress audio done = total; сцени не скидаються, вузли ті самі", () => {
      const { store, view } = mountWith(fixture("directing"));
      const scenesEl = branch("scenes");
      const musicEl = branch("music");
      const codeRow = branch("scenes")?.querySelector(".sp-step");
      store.setState((s) => progress(s, "audio", "Музику записано", 1, 1, "music"));
      expect(branch("scenes")).toBe(scenesEl);
      expect(branch("music")).toBe(musicEl);
      expect(branch("music")?.dataset.state).toBe("done");
      expect(status("music")).toBe("готово");
      expect(barValue(bar("music"))).toBe(1);
      expect(branchSteps("music")).toEqual([["music", "done", ""]]);
      // `progress` тепер описує audio, але гілка «Сцени» тримає свій останній стан.
      expect(status("scenes")).toBe("2/3");
      store.setState((s) => progress(s, "codegen", "Генерую сцени… 3/3", 3, 3, "code"));
      expect(status("scenes")).toBe("3/3");
      expect(status("music")).toBe("готово");
      store.setState((s) => progress(s, "check", "Перевіряю код сцен…", null, null, "check", 9));
      store.setState((s) => progress(s, "check", "Знімаю кадри сцен… 2/6", 2, 6, "stills", 6));
      expect(status("scenes")).toBe("2/6");
      // «check» почався й закінчився наживо — з часом; «code» почався до монтування — без.
      expect(branchSteps("scenes")).toEqual([
        ["code", "done", ""],
        ["check", "done", "6 с"],
        ["stills", "active", "2/6"],
        ["qa", "pending", ""],
      ]);
      expect(branch("scenes")?.querySelector(".sp-step")).toBe(codeRow);
      store.setState((s) => progress(s, "qa", "Перевіряю кадри…", null, null, "qa"));
      expect(branchSteps("scenes").at(-1)).toEqual(["qa", "active", ""]);
      // Без лічильника смуга лишається на останньому відомому значенні гілки.
      expect(barValue(bar("scenes"))).toBeCloseTo(2 / 6);
      view.destroy();
    });

    it("спільні кроки: звук → рецензія → правка за рецензією; гілки закриваються", () => {
      const { store, view } = mountWith(fixture("directing"));
      store.setState((s) => progress(s, "sfx", "Розставляю звук…", null, null, "sfx"));
      expect(branchSteps("scenes").every((r) => r[1] === "done")).toBe(true);
      expect(branch("scenes")?.dataset.state).toBe("done");
      expect(status("scenes")).toBe("готово");
      expect(branchSteps("music")).toEqual([["music", "done", ""]]);
      expect(shared()).toEqual([
        ["sfx", "active", ""],
        ["review", "pending", ""],
      ]);
      store.setState((s) => progress(s, "review", "Рецензент дивиться ролик…", null, null, "review", 30));
      store.setState((s) => progress(s, "review", "Правлю за рецензією…", null, null, "review-fix", 40));
      expect(shared()).toEqual([
        ["sfx", "done", "30 с"],
        ["review", "done", "40 с"],
        ["review-fix", "active", ""],
      ]);
      view.destroy();
    });

    it("виправлення сцен (optional) з'являється, лише коли почалось; повторна перевірка — fix ✓", () => {
      const s0 = fixture("directing");
      expect(sp.directingRows(s0).scenes.map((r) => r.key)).not.toContain("fix");
      const s1 = progress(
        progress(s0, "check", "Перевіряю код сцен…", null, null, "check"),
        "fix",
        "Виправляю сцени… 1/2",
        1,
        2,
        "fix",
      );
      expect(sp.directingRows(s1).scenes.map((r) => [r.key, r.state, r.count])).toEqual([
        ["code", "done", undefined],
        ["check", "done", undefined],
        ["fix", "active", "1/2"],
        ["stills", "pending", undefined],
        ["qa", "pending", undefined],
      ]);
      const s2 = progress(s1, "check", "Перевіряю код сцен…", null, null, "check");
      expect(sp.directingRows(s2).scenes.map((r) => [r.key, r.state])).toEqual([
        ["code", "done"],
        ["check", "active"],
        ["fix", "done"],
        ["stills", "pending"],
        ["qa", "pending"],
      ]);
    });

    it("старі події без step: кроки за stage («Знімаю кадри» з stage check — «Перевіряю код сцен»)", () => {
      const s = withoutSteps(
        playUntil(fixture("awaitingScript"), segments.toStoryboard, byLabel("Знімаю кадри сцен… 4/6")),
      );
      const rows = sp.directingRows(s);
      expect(rows.scenes.map((r) => [r.key, r.state])).toEqual([
        ["code", "done"],
        ["check", "active"],
        ["stills", "pending"],
        ["qa", "pending"],
      ]);
      expect(rows.music.map((r) => r.state)).toEqual(["done"]);
    });

    it("музика «готово» за artifact music", () => {
      const { store, view } = mountWith(fixture("directing"));
      const s = store.getState();
      // Останній audio-рядок ще не done = total, тож без артефакту — пишеться.
      expect(branch("music")?.dataset.state).toBe("running");
      const noAudio = { ...s, feed: s.feed.filter((i) => !(i.kind === "progress" && i.stage === "audio")) };
      store.setState({ feed: noAudio.feed });
      expect(branch("music")?.dataset.state).toBe("pending");
      store.setState({ artifacts: { ...s.artifacts, music: "/files/p1/music.mp3" } });
      expect(branch("music")?.dataset.state).toBe("done");
      expect(status("music")).toBe("готово");
      view.destroy();
    });

    it("справжня послідовність фікстури через reduce: гілки в кожній точці", () => {
      const base = fixture("awaitingScript");
      const events = segments.toStoryboard;
      const at = (label: string) => sp.directingBranches(playUntil(base, events, byLabel(label)));

      let b = at("Генерую сцени і музику…");
      expect(b.scenes.state).toBe("running");
      expect(b.music.state).toBe("pending");

      b = at("Пишу музику…");
      expect(b.scenes.label).toBe("Генерую сцени і музику…");
      expect(b.music).toMatchObject({ state: "running", label: "Пишу музику…" });

      b = at("Генерую сцени… 1/3");
      expect(b.scenes).toMatchObject({ done: 1, total: 3 });
      expect(b.music.state).toBe("running");

      b = at("Музику записано");
      expect(b.scenes).toMatchObject({ done: 2, total: 3 });
      expect(b.music.state).toBe("done");

      b = at("Знімаю кадри сцен… 4/6");
      expect(b.scenes).toMatchObject({ state: "running", done: 4, total: 6 });
      expect(b.music.state).toBe("done");
    });

    it("гілки рахуються лише в поточному busy-стані (повтор після помилки)", () => {
      const failedState = fixture("failed");
      // До retry: у стрічці є рядки directing з невдалої спроби.
      const afterRetry = reduceAll(failedState, segments.retry.slice(0, 3));
      expect(afterRetry.status).toBe("directing");
      const b = sp.directingBranches(afterRetry);
      expect(b.scenes.label).toBe("Генерую сцени і музику…");
      expect(b.music.state).toBe("pending");
    });

    it("ревізія без audio: музика з чекпоінта 3 — «без змін»", () => {
      const base = fixture("revising");
      const s = reduceAll(
        base,
        segments.revisionAfterDelivery.filter((e) => e.event.type === "state").slice(1, 2),
      );
      expect(s.status).toBe("directing");
      expect(s.prevStatus).toBe("revising");
      expect(sp.directingBranches(s).music.state).toBe("kept");
    });
  });

  describe("rendering", () => {
    it("фікстура: 50%, смуга, «9:16 · 1080×1920 · h264 · формат 1 з 2»", () => {
      const { view } = mountWith(fixture("rendering"));
      expect(q(".sp-eyebrow")?.textContent).toBe("05 — Рендер");
      expect(q(".sp-numeral")?.textContent).toBe("50%");
      expect(q(".sp-numeral .numeral__unit")?.textContent).toBe("%");
      expect(barValue(q(".sp-bar"))).toBeCloseTo(0.5);
      expect(q(".sp-caption")?.textContent).toBe("9:16 · 1080×1920 · h264 · формат 1 з 2");
      expect(labels()).toEqual(["9:16 · 1080×1920", "1:1 · 1080×1080"]);
      expect(steps()).toEqual([
        ["render:vertical", "active", "50%"],
        ["render:square", "pending", ""],
      ]);
      view.destroy();
    });

    it("другий формат: відсоток, розмір і номер оновлюються на місці; чекліст форматів", () => {
      const { store, view } = mountWith(fixture("rendering"));
      const numeral = q(".sp-numeral");
      const rows = qa(".sp-step");
      store.setState((s) => progress(s, "render", "Рендерю 9:16… 100%", 100, 100, "render"));
      expect(numeral?.textContent).toBe("100%");
      expect(steps()[0]).toEqual(["render:vertical", "done", ""]);
      store.setState((s) => progress(s, "render", "Рендерю 1:1… 0%", 0, 100, "render"));
      store.setState((s) => progress(s, "render", "Рендерю 1:1… 25%", 25, 100, "render", 3));
      expect(q(".sp-numeral")).toBe(numeral);
      expect(numeral?.textContent).toBe("25%");
      expect(q(".sp-caption")?.textContent).toBe("1:1 · 1080×1080 · h264 · формат 2 з 2");
      expect(steps()).toEqual([
        ["render:vertical", "done", ""],
        ["render:square", "active", "25%"],
      ]);
      store.setState((s) => progress(s, "render", "Рендерю 1:1… 100%", 100, 100, "render", 9));
      expect(steps()[1]).toEqual(["render:square", "done", "12 с"]);
      expect(qa(".sp-step")).toEqual(rows);
      view.destroy();
    });

    it("старт рендеру (мітка з усіма форматами) — 0%, формат 1", () => {
      const s = reduce(
        { ...fixture("awaitingStoryboard"), status: "rendering", stageLog: [], progress: null },
        {
          type: "progress",
          stage: "render",
          label: "Рендерю відео (9:16, 1:1, 16:9)…",
          done: null,
          total: null,
          at: new Date().toISOString(),
        },
        "r-0",
      );
      expect(sp.renderInfo(s)).toEqual({ format: "vertical", index: 0, count: 3, percent: 0 });
      const t = progress(s, "render", "Рендерю 16:9… 40%", 40, 100);
      expect(sp.renderInfo(t)).toEqual({ format: "landscape", index: 2, count: 3, percent: 40 });
    });

    it("без мітки старту — формати з чекпоінта 3 (primaryFormat + sheets)", () => {
      const s = {
        ...fixture("rendering"),
        stageLog: [],
        ui: { ...fixture("rendering").ui, pendingFormats: null },
      };
      expect(sp.renderFormatList(s)).toEqual(["vertical", "square"]);
    });
  });

  it("revising: «Вношу правки» і цитата останнього повідомлення клієнта", () => {
    const { store, view } = mountWith(fixture("revising"));
    expect(q(".sp-title__text")?.textContent).toBe("Вношу правки");
    expect(q(".sp-eyebrow")?.textContent).toBe("06 — Готово");
    const quote = q("blockquote.sp-quote");
    expect(quote?.hidden).toBe(false);
    expect(q(".sp-quote__text")?.textContent).toBe("Зроби заголовок першої сцени коротшим");
    // Подія revise без step — «Розбираю правку» (stage revise).
    expect(labels()).toEqual(["Розбираю правку"]);
    expect(steps()).toEqual([["revise", "active", ""]]);
    // Нове повідомлення клієнта — цитата оновлюється, вузол той самий.
    const s = store.getState();
    store.setState({
      feed: [
        ...s.feed,
        {
          kind: "message",
          id: "u-2",
          at: new Date().toISOString(),
          role: "user",
          text: "І музику тихіше\nбудь ласка",
          buttons: [],
        },
      ],
    });
    expect(q("blockquote.sp-quote")).toBe(quote);
    expect(q(".sp-quote__text")?.textContent).toBe("І музику тихішебудь ласка");
    expect(q(".sp-quote__text br")).not.toBeNull();
    view.destroy();
  });

  it("revising: далі — кроки стадій, що реально прийшли, у порядку появи", () => {
    const { store, view } = mountWith(fixture("revising"));
    store.setState((s) => progress(s, "storyboard", "Пишу сценарій…", null, null, "brief", 4));
    store.setState((s) => progress(s, "storyboard", "Пишу концепт і сцени…", null, null, "write", 7));
    store.setState((s) => progress(s, "codegen", "Генерую сцени… 1/2", 1, 2, "code", 20));
    expect(labels()).toEqual([
      "Розбираю правку",
      "Читаю бренд-кіт і сайт",
      "Пишу концепт і сцени",
      "Пишу анімацію сцен",
    ]);
    // «Розбираю правку» почалась до монтування — без часу; brief і write — наживо.
    expect(steps()).toEqual([
      ["revise", "done", ""],
      ["brief", "done", "7 с"],
      ["write", "done", "20 с"],
      ["code", "active", "1/2"],
    ]);
    view.destroy();
  });

  it("revising без жодної події — «Розбираю правку» зі спінером", () => {
    const s = fixture("revising");
    expect(sp.revisingRows({ ...s, feed: s.feed.filter((i) => i.kind !== "progress") })).toEqual([
      { key: "revise", label: "Розбираю правку", state: "active", implicit: true },
    ]);
  });

  it("formatDuration: секунди і хвилини", () => {
    expect(sp.formatDuration(400)).toBe("1 с");
    expect(sp.formatDuration(12_300)).toBe("12 с");
    expect(sp.formatDuration(65_000)).toBe("1 хв 05 с");
  });

  it("revising без повідомлення клієнта — цитата схована", () => {
    const s = fixture("revising");
    const { view } = mountWith({
      ...s,
      feed: s.feed.filter((i) => !(i.kind === "message" && i.role === "user")),
    });
    expect(q("blockquote.sp-quote")?.hidden).toBe(true);
    view.destroy();
  });
});

describe("views/failed.js (X4)", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    document.body.textContent = "";
  });

  function mountWith(state: UiState) {
    const store = createStore(state);
    const actions = createDevActions(store);
    const view = failed.mount(host, { store, actions });
    store.subscribe((s, prev) => view.update(s, prev));
    return { store, actions, view };
  }
  const q = (sel: string) => host.querySelector<HTMLElement>(sel);

  it("eyebrow з етапом, заголовок, лід з ErrorEvent.message", () => {
    const { view } = mountWith(fixture("failed"));
    const eyebrow = q(".sp-failed__eyebrow");
    expect(eyebrow?.textContent).toBe("Помилка · етап codegen");
    expect(eyebrow?.querySelector(".dot.dot--danger")).not.toBeNull();
    const h1 = q("h1");
    expect(h1?.textContent).toBe("Щось пішло не так");
    expect(h1?.classList.contains("display-l")).toBe(true);
    expect(q(".sp-failed__lead")?.textContent).toBe(
      "Модель не відповіла вчасно. Повідомлення, які ви надішлете зараз, я збережу й врахую на наступному погодженні.",
    );
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("«Спробувати ще раз» → retry, «Новий проєкт» → newProject", async () => {
    const { actions, view } = mountWith(fixture("failed"));
    const retry = q('button[data-action="retry"]') as HTMLButtonElement;
    expect(retry.textContent).toBe("Спробувати ще раз");
    expect(retry.className).toBe("btn btn--primary");
    const spy = vi.spyOn(actions, "retry");
    retry.click();
    expect(retry.disabled).toBe(true);
    retry.click(); // повторний клік під час запиту ігнорується
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(retry.disabled).toBe(false);
    const fresh = q('button[data-action="new-project"]') as HTMLButtonElement;
    expect(fresh.textContent).toBe("Новий проєкт");
    expect(fresh.className).toBe("btn btn--ghost");
    fresh.click();
    expect(actions.calls.map((c) => c.name)).toEqual(["retry", "newProject"]);
    view.destroy();
  });

  it("неповторна помилка: без «Спробувати ще раз», «Новий проєкт» — primary", () => {
    const s = fixture("failed");
    const { store, view } = mountWith({
      ...s,
      error: { stage: null, message: "сайт недоступний", retryable: false },
    });
    expect(q('button[data-action="retry"]')?.hidden).toBe(true);
    expect(q('button[data-action="new-project"]')?.className).toBe("btn btn--primary");
    expect(q(".sp-failed__eyebrow")?.textContent).toBe("Помилка");
    expect(q(".sp-failed__message")?.textContent).toBe("Сайт недоступний.");
    store.setState({ error: { stage: "render", message: "Таймаут!", retryable: true } });
    expect(q('button[data-action="retry"]')?.hidden).toBe(false);
    expect(q(".sp-failed__eyebrow")?.textContent).toBe("Помилка · етап render");
    expect(q(".sp-failed__message")?.textContent).toBe("Таймаут!");
    view.destroy();
  });

  it("без state.error — запасний текст, кнопка повтору є", () => {
    const { view } = mountWith({ ...fixture("failed"), error: null });
    expect(q(".sp-failed__message")?.textContent).toBe("Етап завершився з помилкою.");
    expect(q('button[data-action="retry"]')?.hidden).toBe(false);
    view.destroy();
  });
});

describe("безпека і рух", () => {
  const files = ["js/views/stage-progress.js", "js/views/failed.js"].map((f) =>
    readFileSync(path.join(STATIC_DIR, f), "utf8"),
  );

  it("без innerHTML, eval та інлайнових on*-атрибутів", () => {
    for (const src of files) {
      expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
      expect(src).not.toMatch(/setAttribute\(\s*["']on/);
    }
  });

  it("CSS: префікс .sp-, анімації поважають prefers-reduced-motion", () => {
    const css = readFileSync(path.join(STATIC_DIR, "css", "stage-progress.css"), "utf8");
    const classes = [...css.matchAll(/(?<![\w-])\.([a-z][\w-]*)/g)].map((m) => m[1] ?? "");
    const foreign = classes.filter((c) => !c.startsWith("sp-") && c !== "sp" && c !== "bar__fill");
    expect(foreign).toEqual([]);
    // Нескінченні анімації — лише adc-* (вимикаються в base.css) або власні з блоком reduced-motion.
    const own = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(own).toEqual(["sp-indeterminate"]);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*sp-bar--unknown[\s\S]*animation: none/,
    );
    expect(css).toMatch(/\.sp-pulse\s*\{[^}]*animation: adc-pulse/);
  });
});
