// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { scriptPayload } from "../../public/static/dev/fixture-events.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { ScriptCheckpointPayload, UiState } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import {
  ALL_VERIFIED,
  formatMeta,
  highlight,
  isActive,
  mount,
  NOTE_UNVERIFIED,
  plural,
  safeMediaUrl,
} from "../../public/static/js/views/cp-script.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

function withPayload(state: UiState, payload: ScriptCheckpointPayload): UiState {
  const entry = state.checkpoints.script;
  if (!entry) throw new Error("немає чекпоінта script");
  return { ...state, checkpoints: { ...state.checkpoints, script: { ...entry, payload } } };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
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

const row = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`.cs-scene[data-scene="${id}"]`);
const meta = (r: HTMLElement | null, key: string) => r?.querySelector(`[data-meta="${key}"] dd`)?.textContent;

describe("cp-script · шапка", () => {
  it("eyebrow з ромбом і ревізією, кнопки активні в awaiting_script при open", () => {
    const { $ } = setup(fixture("awaitingScript"));
    expect($(".cs-eyebrow")?.classList.contains("eyebrow")).toBe(true);
    expect($(".cs-eyebrow")?.textContent).toBe("Чекпоінт 2 / 3 · Тексти · ревізія 1");
    expect($(".cs-eyebrow .diamond.diamond--open")).not.toBeNull();
    const edit = $<HTMLButtonElement>(".cs-edit");
    const approve = $<HTMLButtonElement>(".cs-approve");
    expect(edit?.textContent).toBe("Правки");
    expect(edit?.classList.contains("btn--ghost")).toBe(true);
    expect(approve?.textContent).toBe("Затвердити→");
    expect(approve?.classList.contains("btn--primary")).toBe(true);
    expect(edit?.disabled).toBe(false);
    expect(approve?.disabled).toBe(false);
  });

  it("«Затвердити» → approve, «Правки» → startEdit", async () => {
    const { $, names, store } = setup(fixture("awaitingScript"));
    $<HTMLButtonElement>(".cs-edit")?.click();
    expect(names()).toContain("startEdit");
    expect(store.getState().ui.editing).toBe(true);
    $<HTMLButtonElement>(".cs-approve")?.click();
    await vi.waitFor(() => expect(names()).toContain("approve"));
    expect(names().filter((n) => n === "approve")).toHaveLength(1);
  });

  it("поза awaiting_script або коли чекпоінт не open — кнопки вимкнені й нічого не кличуть", () => {
    const base = fixture("awaitingScript");
    const { $, names, store } = setup(base);
    const approve = $<HTMLButtonElement>(".cs-approve") as HTMLButtonElement;
    const edit = $<HTMLButtonElement>(".cs-edit") as HTMLButtonElement;

    store.setState({ status: "directing" });
    expect(approve.disabled).toBe(true);
    expect(edit.disabled).toBe(true);
    approve.click();
    edit.click();
    expect(names()).toEqual([]);

    store.setState({ status: "awaiting_script" });
    expect(approve.disabled).toBe(false);

    const entry = base.checkpoints.script;
    if (!entry) throw new Error("немає чекпоінта");
    store.setState({ checkpoints: { ...base.checkpoints, script: { ...entry, state: "approved" } } });
    expect(approve.disabled).toBe(true);
    expect($(".cs-eyebrow .diamond")?.classList.contains("diamond--done")).toBe(true);
    expect($(".cs-eyebrow .diamond")?.classList.contains("diamond--open")).toBe(false);
  });

  it("isActive", () => {
    const s = fixture("awaitingScript");
    expect(isActive(s)).toBe(true);
    expect(isActive({ ...s, status: "scripting" })).toBe(false);
    expect(isActive({ ...s, checkpoints: { ...s.checkpoints, script: null } })).toBe(false);
  });
});

describe("cp-script · концепт, трек, сцени (S3)", () => {
  it("концепт display-m, хук, мета з комою", () => {
    const { $ } = setup(fixture("awaitingScript"));
    const concept = $(".cs-concept");
    expect(concept?.classList.contains("display-m")).toBe(true);
    expect(concept?.textContent).toBe("Ранок у «Зерні»: від зерна до чашки");
    expect($(".cs-hook")?.textContent).toBe("Хук: «Кава, яку обсмажуємо самі»");
    expect($(".cs-meta")?.textContent).toBe("15,0 с · 30 fps · 3 сцени");
  });

  it("трек: блоки пропорційно таймлайну, кольори, смугасті переходи, шкала секунд", () => {
    const { $$ } = setup(fixture("awaitingScript"));
    const blocks = $$(".cs-track .cs-block");
    expect(blocks.map((b) => b.dataset.scene)).toEqual(["s1", "s2", "s3"]);
    expect(blocks.map((b) => [...b.classList].find((c) => c.startsWith("cs-block--")))).toEqual([
      "cs-block--ink",
      "cs-block--t2",
      "cs-block--t3",
    ]);
    expect(blocks.map((b) => [b.style.getPropertyValue("--l"), b.style.getPropertyValue("--w")])).toEqual([
      ["0%", "30%"],
      ["33.333%", "30%"],
      ["66.667%", "33.333%"],
    ]);
    const transitions = $$(".cs-track .cs-transition");
    expect(transitions.map((t) => [t.dataset.from, t.dataset.to, t.dataset.frames])).toEqual([
      ["s1", "s2", "15"],
      ["s2", "s3", "15"],
    ]);
    expect(transitions[0]?.style.getPropertyValue("--l")).toBe("30%");
    expect($$(".cs-scale__mark")).toHaveLength(16);
    expect($$(".cs-scale__label").map((l) => l.textContent)).toEqual(["0 с", "5 с", "10 с", "15 с"]);
  });

  it("чергування --track-2/--track-3 і склейки без переходів", () => {
    const sb = scriptPayload.storyboard;
    const base = sb.scenes[1];
    if (!base) throw new Error("немає сцени");
    const scenes = ["s2", "s3", "s4", "s5"].map((id) => ({ ...base, id, transitionFrames: 0 }));
    const payload = {
      ...scriptPayload,
      storyboard: { ...sb, scenes: [...sb.scenes.slice(0, 1), ...scenes] },
    };
    const { $$ } = setup(withPayload(fixture("awaitingScript"), payload));
    expect($$(".cs-block").map((b) => [...b.classList].find((c) => c.startsWith("cs-block--")))).toEqual([
      "cs-block--ink",
      "cs-block--t2",
      "cs-block--t3",
      "cs-block--t2",
      "cs-block--t3",
    ]);
    expect($$(".cs-transition")).toHaveLength(0);
  });

  it("рядки сцен: номер, purpose і тривалість, headline, sub, рух, факти, перехід, звук", () => {
    const { el } = setup(fixture("awaitingScript"));
    const rows = [...el.querySelectorAll<HTMLElement>(".cs-scenes > .cs-scene")];
    expect(rows.map((r) => r.dataset.scene)).toEqual(["s1", "s2", "s3"]);
    expect(rows.every((r) => r.classList.contains("spec-row"))).toBe(true);

    const s1 = row(el, "s1");
    const num = s1?.querySelector(".cs-scene__num");
    expect(num?.textContent).toBe("01");
    expect(num?.classList.contains("display-s")).toBe(true);
    expect(s1?.querySelector(".cs-scene__purpose")?.textContent).toBe("хук · 5,0 с");
    const head = s1?.querySelector(".cs-scene__head");
    expect(head?.classList.contains("scene-head")).toBe(true);
    expect(head?.textContent).toBe("Кава, яку обсмажуємо самі");
    expect(s1?.querySelector(".cs-scene__sub")).toBeNull();
    expect(meta(s1, "motion")).toBe("повільний наїзд на фото, заголовок по словах");
    expect(meta(s1, "facts")).toBe("—");
    expect(meta(s1, "transition")).toBe("—");
    expect(meta(s1, "sfx")).toBe("whoosh");

    const s2 = row(el, "s2");
    expect(s2?.querySelector(".cs-scene__purpose")?.textContent).toBe("пропозиція · 5,5 с");
    expect(s2?.querySelector(".cs-scene__sub")?.textContent).toBe("-10% на каву з собою до 10:00");
    expect(meta(s2, "facts")).toBe("✓ f1, f2");
    expect(meta(s2, "transition")).toBe("зсув · 0,5 с");
    expect(meta(s2, "sfx")).toBe("pop");
  });

  it("мініатюри: <img> з безпечним URL у рядку сцени з цим асетом", () => {
    const { el } = setup(fixture("awaitingScript"));
    const imgs = [...el.querySelectorAll<HTMLImageElement>("img")];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute("src")).toBe("/static/dev/media/photo-a01.svg");
    expect(imgs[0]?.closest(".cs-scene")?.getAttribute("data-scene")).toBe("s1");
  });

  it("мініатюри без сцени — окремий рядок «Фото»; небезпечні URL відкидаються", () => {
    const payload = {
      ...scriptPayload,
      thumbnails: [
        { assetId: "a01", url: "/files/p1/assets/a01.jpg" },
        { assetId: "x1", url: "/files/p1/assets/x1.jpg" },
        { assetId: "x2", url: "https://cdn.example.com/x2.jpg" },
        { assetId: "x3", url: "javascript:alert(1)" },
        { assetId: "x4", url: "data:image/svg+xml,<svg/>" },
        { assetId: "x5", url: "//evil.example.com/x.jpg" },
      ],
    };
    const { el, $ } = setup(withPayload(fixture("awaitingScript"), payload));
    expect([...el.querySelectorAll("img")].map((i) => i.getAttribute("data-asset"))).toEqual([
      "a01",
      "x1",
      "x2",
    ]);
    expect($(".cs-photos .spec-row__label")?.textContent).toBe("Фото");
    expect([...el.querySelectorAll(".cs-photos img")].map((i) => i.getAttribute("src"))).toEqual([
      "/files/p1/assets/x1.jpg",
      "https://cdn.example.com/x2.jpg",
    ]);
  });

  it("музичний бриф: жанр display-s, настрій чипами, BPM та інструменти mono", () => {
    const { $, $$ } = setup(fixture("awaitingScript"));
    const genre = $(".cs-music__genre");
    expect(genre?.classList.contains("display-s")).toBe(true);
    expect(genre?.textContent).toBe("lo-fi hip hop");
    expect($$(".cs-music__mood .chip").map((c) => c.textContent)).toEqual(["теплий", "ранковий"]);
    expect($(".cs-music__tech")?.classList.contains("mono")).toBe(true);
    expect($(".cs-music__bpm")?.textContent).toBe("85 BPM");
    expect($(".cs-music__instr")?.textContent).toBe("rhodes · soft drums · vinyl crackle");
  });
});

describe("cp-script · твердження (X3)", () => {
  it("без unverified — рядок ✓ і жодної підсвітки", () => {
    const { $, el } = setup(fixture("awaitingScript"));
    expect($(".cs-claims--ok")?.textContent).toBe(ALL_VERIFIED);
    expect(el.querySelector("mark")).toBeNull();
    expect(el.querySelector(".cs-unverified")).toBeNull();
    expect(el.querySelector(".cs-note")).toBeNull();
  });

  it("з unverified — підсвітка фрагмента, рядок «не підтверджено» і примітка", () => {
    const { $, el } = setup(fixture("awaitingScriptUnverified"));
    expect($(".cs-claims--ok")).toBeNull();
    const head = row(el, "s1")?.querySelector(".cs-scene__head");
    expect(head?.textContent).toBe("Найкраща кава №1 у Львові");
    const marks = [...(head?.querySelectorAll("mark.cs-mark") ?? [])];
    expect(marks.map((m) => m.textContent)).toEqual(["№1"]);
    expect([...(head?.childNodes ?? [])].map((n) => n.nodeName)).toEqual(["#text", "MARK", "#text"]);
    const line = row(el, "s1")?.querySelector(".cs-unverified");
    expect(line?.textContent).toBe("не підтверджено: «№1»");
    expect(line?.querySelector(".dot--accent")).not.toBeNull();
    expect($(".cs-note")?.textContent).toBe(NOTE_UNVERIFIED);
    expect(row(el, "s2")?.querySelector("mark, .cs-unverified")).toBeNull();
  });

  it("твердження в sub і твердження без сцени", () => {
    const payload: ScriptCheckpointPayload = {
      ...scriptPayload,
      claims: {
        ...scriptPayload.claims,
        unverified: [
          { sceneId: "s2", field: "sub", text: "-10%", kind: "percent", factId: null, matchedContact: false },
          {
            sceneId: "zz",
            field: "headline",
            text: "назавжди",
            kind: "guarantee",
            factId: null,
            matchedContact: false,
          },
        ],
      },
    };
    const { el, $ } = setup(withPayload(fixture("awaitingScript"), payload));
    expect(row(el, "s2")?.querySelector(".cs-scene__head mark")).toBeNull();
    expect(row(el, "s2")?.querySelector(".cs-scene__sub mark")?.textContent).toBe("-10%");
    expect([...el.querySelectorAll(".cs-claims .cs-unverified")].map((n) => n.textContent)).toEqual([
      "не підтверджено: «назавжди»",
    ]);
    expect($(".cs-note")).not.toBeNull();
  });

  it("highlight: текстові вузли + <mark>, усі входження, перекриття зливаються, текст не парситься як HTML", () => {
    const wrap = (nodes: Node[]) => {
      const p = document.createElement("p");
      p.append(...nodes);
      return p;
    };
    const p = wrap(highlight("№1 і знову №1", ["№1"]));
    expect([...p.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["№1", "№1"]);
    expect(p.textContent).toBe("№1 і знову №1");

    const merged = wrap(highlight("від 499 грн", ["499", "499 грн"]));
    expect([...merged.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["499 грн"]);

    const html = wrap(highlight("<img src=x onerror=alert(1)> 100%", ["100%", "", "немає"]));
    expect(html.querySelector("img")).toBeNull();
    expect(html.textContent).toBe("<img src=x onerror=alert(1)> 100%");
    expect(html.querySelector("mark")?.textContent).toBe("100%");

    expect(wrap(highlight("", ["x"])).textContent).toBe("");
  });
});

describe("cp-script · update", () => {
  it("той самий payload — вузли не перестворюються; статус лише перемикає кнопки", () => {
    const { $, store } = setup(fixture("awaitingScript"));
    const concept = $(".cs-concept");
    const track = $(".cs-track");
    const approve = $(".cs-approve");
    store.setState((s) => ({ ui: { ...s.ui, notice: "x" }, totalUsd: s.totalUsd + 1 }));
    store.setState({ status: "directing" });
    store.setState({ status: "awaiting_script" });
    expect($(".cs-concept")).toBe(concept);
    expect($(".cs-track")).toBe(track);
    expect($(".cs-approve")).toBe(approve);
    // Новий об'єкт запису з тим самим payload і ревізією (наприклад, зміна state) — без перебудови.
    const entry = store.getState().checkpoints.script;
    if (!entry) throw new Error("немає чекпоінта");
    store.setState((s) => ({ checkpoints: { ...s.checkpoints, script: { ...entry } } }));
    expect($(".cs-concept")).toBe(concept);
  });

  it("нова ревізія payload — вміст перебудовується, eyebrow оновлюється", () => {
    const { $, store } = setup(fixture("awaitingScript"));
    const concept = $(".cs-concept");
    const entry = store.getState().checkpoints.script;
    if (!entry) throw new Error("немає чекпоінта");
    const payload = {
      ...scriptPayload,
      storyboard: { ...scriptPayload.storyboard, concept: "Новий концепт" },
    };
    store.setState((s) => ({ checkpoints: { ...s.checkpoints, script: { ...entry, rev: 2, payload } } }));
    expect($(".cs-concept")).not.toBe(concept);
    expect($(".cs-concept")?.textContent).toBe("Новий концепт");
    expect($(".cs-eyebrow")?.textContent).toBe("Чекпоінт 2 / 3 · Тексти · ревізія 2");
  });

  it("без payload чекпоінта — порожній стан, кнопки вимкнені", () => {
    const s = fixture("awaitingScript");
    const { $ } = setup({ ...s, checkpoints: { ...s.checkpoints, script: null } });
    expect($(".cs-empty")?.textContent).toBe("Сценарій ще не надійшов.");
    expect($<HTMLButtonElement>(".cs-approve")?.disabled).toBe(true);
  });

  it("destroy прибирає розмітку", () => {
    const { el, view } = setup(fixture("awaitingScript"));
    view.destroy();
    expect(el.querySelector(".cs")).toBeNull();
  });
});

describe("cp-script · допоміжне", () => {
  it("formatMeta і множина", () => {
    expect(formatMeta(scriptPayload)).toBe("15,0 с · 30 fps · 3 сцени");
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map((n) => plural(n, ["сцена", "сцени", "сцен"]))).toEqual([
      "сцена",
      "сцени",
      "сцени",
      "сцен",
      "сцен",
      "сцен",
      "сцена",
      "сцени",
      "сцен",
    ]);
    expect(formatMeta({ ...scriptPayload, durationSeconds: 16.5 })).toBe("16,5 с · 30 fps · 3 сцени");
  });

  it("safeMediaUrl", () => {
    expect(safeMediaUrl("/files/p1/a.png")).toBe("/files/p1/a.png");
    expect(safeMediaUrl("https://x.example/a.png")).toBe("https://x.example/a.png");
    expect(safeMediaUrl("javascript:alert(1)")).toBeNull();
    expect(safeMediaUrl("data:image/png;base64,AA")).toBeNull();
    expect(safeMediaUrl("//evil.example/a.png")).toBeNull();
    expect(safeMediaUrl("files/a.png")).toBeNull();
    expect(safeMediaUrl(null)).toBeNull();
  });

  it("у модулі немає innerHTML / eval / інлайнових on*-атрибутів", () => {
    const src = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "static/js/views/cp-script.js"), "utf8");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
    expect(src).not.toMatch(/setAttribute\(\s*["']on/);
  });
});
