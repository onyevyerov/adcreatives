// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { SoundCue } from "@adc/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { scriptPayload } from "../../public/static/dev/fixture-events.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { ScriptCheckpointPayload, UiState } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import {
  ALL_VERIFIED,
  FACTS_FROM_BRANDKIT,
  factsLabel,
  formatMeta,
  highlight,
  isActive,
  mount,
  NOTE_UNVERIFIED,
  plural,
  SFX_LABELS,
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
  it("концепт рівня заголовків сцен (display-s, не display-m), хук, мета з комою", () => {
    const { $ } = setup(fixture("awaitingScript"));
    const concept = $(".cs-concept");
    expect(concept?.classList.contains("display-s")).toBe(true);
    expect(concept?.classList.contains("display-m")).toBe(false);
    expect(concept?.textContent).toBe("Ранок у «Зерні»: від зерна до чашки");
    expect($(".cs-hook")?.textContent).toBe("Хук: «Кава, яку обсмажуємо самі»");
    expect($(".cs-meta")?.textContent).toBe("15,0 с · 30 кадр/с · 3 сцени");
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

  it("рядки сцен: номер, purpose і тривалість, headline, sub, факти, перехід, звук (стара розкадровка)", () => {
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
    // Без motionNote рядка «Рух» немає: motionIntent власнику не показуємо.
    expect(s1?.querySelector('[data-meta="motion"]')).toBeNull();
    expect(meta(s1, "facts")).toBe("—");
    expect(meta(s1, "transition")).toBe("—");
    expect(meta(s1, "sfx")).toBe("проліт");

    const s2 = row(el, "s2");
    expect(s2?.querySelector(".cs-scene__purpose")?.textContent).toBe("пропозиція · 5,5 с");
    expect(s2?.querySelector(".cs-scene__sub")?.textContent).toBe("-10% на каву з собою до 10:00");
    expect(meta(s2, "facts")).toBe("✓ «75 грн», «-10%»");
    expect(meta(s2, "transition")).toBe("зсув · 0,5 с");
    expect(meta(s2, "sfx")).toBe("поп");
  });

  it("«Рух» = motionNote; музика = musicNote (n5-cp2)", () => {
    const { el, $ } = setup(fixture("n5-cp2"));
    expect(meta(row(el, "s1"), "motion")).toBe(
      "Камера повільно наїжджає на фото кав'ярні, заголовок з'являється слово за словом.",
    );
    expect(meta(row(el, "s3"), "motion")).toBe(
      "Логотип м'яко з'являється, під ним пульсує кнопка бронювання.",
    );
    expect($(".cs-music__note")?.textContent).toBe(
      "Теплий ранковий лоу-фай хіп-хоп з електропіаніно, неспішний, ~85 BPM",
    );
    expect(el.textContent).not.toContain("lo-fi hip hop");
    // Темп уже в musicNote — окремого рядка BPM немає.
    expect($(".cs-music__bpm")).toBeNull();
  });

  it("англійський motionIntent не показується; порожній motionNote — як відсутній", () => {
    const sb = scriptPayload.storyboard;
    const payload = {
      ...scriptPayload,
      storyboard: {
        ...sb,
        scenes: sb.scenes.map((s, i) => ({
          ...s,
          motionIntent: "The teal dot swells into a report card.",
          motionNote: i === 0 ? "   " : "Точка розростається в картку звіту.",
        })),
        musicNote: "",
      },
    };
    const { el, $ } = setup(withPayload(fixture("awaitingScript"), payload));
    expect(el.textContent).not.toContain("teal dot");
    expect(row(el, "s1")?.querySelector('[data-meta="motion"]')).toBeNull();
    expect(meta(row(el, "s2"), "motion")).toBe("Точка розростається в картку звіту.");
    // Порожній musicNote — запасний жанр.
    expect($(".cs-music__note")?.textContent).toBe("lo-fi hip hop");
  });

  it("на ЧП2 з примітками немає англійського службового тексту (крім BPM)", () => {
    const { $, $$ } = setup(fixture("n5-cp2"));
    const body = $(".cs-body")?.cloneNode(true) as HTMLElement;
    // Тексти в кадрі — мовою відео; їх не перевіряємо.
    for (const n of body.querySelectorAll(".cs-scene__head, .cs-scene__sub")) n.remove();
    const latin = (body.textContent ?? "").match(/[A-Za-z]{2,}/g) ?? [];
    expect(latin.filter((w) => w !== "BPM")).toEqual([]);
    expect($$(".cs-scene [data-meta]").length).toBeGreaterThan(0);
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

  it("музика старої розкадровки: жанр body-l і BPM mono; англійських настрою й інструментів немає", () => {
    const { $, el } = setup(fixture("awaitingScript"));
    const note = $(".cs-music__note");
    expect(note?.classList.contains("body-l")).toBe(true);
    expect(note?.textContent).toBe("lo-fi hip hop");
    expect($(".cs-music__tech")?.classList.contains("mono")).toBe(true);
    expect($(".cs-music__bpm")?.textContent).toBe("85 BPM");
    expect(el.querySelector(".cs-music .chip")).toBeNull();
    expect(el.textContent).not.toContain("rhodes");
  });

  it("звук: українська назва cue; null чи невідомий ключ — рядка немає", () => {
    const sb = scriptPayload.storyboard;
    const cues = [null, "custom-brand-jingle", "impact"];
    const payload = {
      ...scriptPayload,
      storyboard: { ...sb, scenes: sb.scenes.map((s, i) => ({ ...s, sfxCue: cues[i] ?? null })) },
    };
    const { el } = setup(withPayload(fixture("awaitingScript"), payload));
    expect(row(el, "s1")?.querySelector('[data-meta="sfx"]')).toBeNull();
    expect(row(el, "s2")?.querySelector('[data-meta="sfx"]')).toBeNull();
    expect(meta(row(el, "s3"), "sfx")).toBe("удар");
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
          {
            sceneId: "s2",
            field: "sub",
            itemId: null,
            text: "-10%",
            kind: "percent",
            factId: null,
            matchedContact: false,
            matchedSite: false,
          },
          {
            sceneId: "zz",
            field: "headline",
            itemId: null,
            text: "назавжди",
            kind: "guarantee",
            factId: null,
            matchedContact: false,
            matchedSite: false,
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
    expect(formatMeta(scriptPayload)).toBe("15,0 с · 30 кадр/с · 3 сцени");
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
    expect(formatMeta({ ...scriptPayload, durationSeconds: 16.5 })).toBe("16,5 с · 30 кадр/с · 3 сцени");
  });

  it("factsLabel: тексти підтверджених тверджень сцени без повторів, інакше позначка або «—», без id", () => {
    const verified = [
      { sceneId: "s2", text: "+25%" },
      { sceneId: "s2", text: "4080" },
      { sceneId: "s2", text: "+25%" },
      { sceneId: "s1", text: "№1" },
    ];
    expect(factsLabel({ id: "s2", factIds: ["f7", "f35"] }, verified)).toBe("✓ «+25%», «4080»");
    expect(factsLabel({ id: "s3", factIds: ["f7", "f35"] }, verified)).toBe(FACTS_FROM_BRANDKIT);
    expect(factsLabel({ id: "s3", factIds: [] }, verified)).toBe("—");
  });

  it("SFX_LABELS покриває всі SoundCue і лише українською", () => {
    expect(Object.keys(SFX_LABELS).sort()).toEqual([...SoundCue.options].sort());
    for (const label of Object.values(SFX_LABELS)) expect(label).not.toMatch(/[A-Za-z]/);
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
