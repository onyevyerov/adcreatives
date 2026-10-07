// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { Actions, UiState } from "../../public/static/js/contracts.js";
import { SEGMENTS } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import { EXAMPLE_HOST, formatTime, MAX_PHOTOS, mount } from "../../public/static/js/views/start.js";

type CreateProject = Actions["createProject"];

function startState(): UiState {
  const s = fixtureStates.start;
  if (!s) throw new Error("немає фікстури start");
  return s;
}

function setup(createProject: CreateProject = vi.fn(async () => {})) {
  const el = document.createElement("section");
  document.body.append(el);
  const store = createStore(startState());
  const actions = { createProject } as unknown as Actions;
  const view = mount(el, { store, actions });
  let prev = store.getState();
  store.subscribe((state) => {
    view.update(state, prev);
    prev = state;
  });
  const q = <T extends Element>(sel: string) => {
    const node = el.querySelector<T>(sel);
    if (!node) throw new Error(`немає ${sel}`);
    return node;
  };
  const setUi = (patch: Partial<UiState["ui"]>) => store.setState((s) => ({ ui: { ...s.ui, ...patch } }));
  const submit = () => q<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true }));
  return { el, store, view, q, setUi, submit, createProject };
}

function setFiles(input: HTMLInputElement, count: number) {
  const files = Array.from({ length: count }, (_, i) => new File(["x"], `p${i}.jpg`, { type: "image/jpeg" }));
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
  return files;
}

/** FormData першого виклику createProject. */
function sentForm(fn: { mock: { calls: Parameters<CreateProject>[] } }): FormData {
  const form = fn.mock.calls[0]?.[0];
  if (!form) throw new Error("createProject не викликано");
  return form;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.textContent = "";
});

describe("views/start.js", () => {
  it("рендериться з fixtureStates.start", () => {
    const { q, el } = setup();
    expect(q(".st-head .wordmark").textContent).toBe("AdCreative");
    expect(q(".st-demo").textContent).toBe("Демо · v0");
    const title = q("h1.display-xl");
    expect(title.querySelector(".accent-dot")?.textContent).toBe(".");
    expect(q(".st-lead").classList.contains("body-l")).toBe(true);
    expect(q<HTMLInputElement>('input[name="url"]').value).toBe("");
    expect(q(".st-submit").textContent).toContain("Почати");
    expect(q<HTMLButtonElement>(".st-submit").disabled).toBe(false);
    expect(q<HTMLParagraphElement>(".st-error").hidden).toBe(true);
    expect(q(".st-error").getAttribute("role")).toBe("alert");

    const file = q<HTMLInputElement>('input[type="file"][name="photos"]');
    expect(file.multiple).toBe(true);
    expect(file.getAttribute("accept")).toBe("image/*,.heic,.heif");
    expect(q(".st-photos").textContent).toBe(`+ Фото (до ${MAX_PHOTOS})`);
    expect(q<HTMLDivElement>(".st-manual").hidden).toBe(true);

    const video = q<HTMLVideoElement>("video");
    expect(video.getAttribute("src")).toBe("/static/media/sample-9x16.mp4");
    expect(video.getAttribute("poster")).toBe("/static/media/sample-9x16.jpg");
    expect(video.muted).toBe(true);
    expect(video.hasAttribute("loop")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(q(".st-time").textContent).toBe("0:00 / 0:00");

    const segs = [...el.querySelectorAll(".st-legend__seg")].map((n) => n.textContent);
    expect(segs).toEqual(SEGMENTS.map((s, i) => `0${i + 1} ${s.label}`));
    const diamonds = [...el.querySelectorAll<HTMLElement>(".st-legend__diamond")];
    expect(diamonds.map((d) => d.style.left)).toEqual(["34.33%", "52.24%", "76.12%"]);
    expect(el.querySelector(".diamond--open, .diamond--done")).toBeNull();
    expect(q(".st-note").textContent).toContain("Три чекпоінти");
  });

  it("«Приклад» підставляє адресу", () => {
    const { q } = setup();
    q<HTMLButtonElement>(".st-example").click();
    expect(q<HTMLInputElement>('input[name="url"]').value).toBe(EXAMPLE_HOST);
  });

  it("«Немає сайту?» розкриває і ховає textarea manualText", () => {
    const { q } = setup();
    const toggle = q<HTMLButtonElement>(".st-manual-toggle");
    toggle.click();
    expect(q<HTMLDivElement>(".st-manual").hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(q('textarea[name="manualText"]')).toBeTruthy();
    toggle.click();
    expect(q<HTMLDivElement>(".st-manual").hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("сабміт з адресою і фото кличе createProject з правильним FormData", async () => {
    const createProject = vi.fn<CreateProject>(async () => {});
    const { q, submit } = setup(createProject);
    q<HTMLInputElement>('input[name="url"]').value = "  zerno.example.com ";
    const files = setFiles(q<HTMLInputElement>('input[name="photos"]'), 3);
    expect(q(".st-photos").textContent).toBe("Фото: 3");
    submit();
    await flush();
    expect(createProject).toHaveBeenCalledOnce();
    const form = sentForm(createProject);
    expect(form.get("url")).toBe("zerno.example.com");
    expect(form.has("manualText")).toBe(false);
    const sent = form.getAll("photos") as File[];
    expect(sent.map((f) => f.name)).toEqual(files.map((f) => f.name));
  });

  it("сабміт з описом бізнесу без адреси шле лише manualText", async () => {
    const createProject = vi.fn<CreateProject>(async () => {});
    const { q, submit } = setup(createProject);
    q<HTMLButtonElement>(".st-manual-toggle").click();
    q<HTMLTextAreaElement>('textarea[name="manualText"]').value = "Кав'ярня на Подолі.";
    submit();
    await flush();
    const form = sentForm(createProject);
    expect([...form.keys()]).toEqual(["manualText"]);
    expect(form.get("manualText")).toBe("Кав'ярня на Подолі.");
  });

  it("порожній сабміт показує помилку і не кличе createProject", async () => {
    const createProject = vi.fn<CreateProject>(async () => {});
    const { q, submit } = setup(createProject);
    submit();
    await flush();
    expect(createProject).not.toHaveBeenCalled();
    const err = q<HTMLParagraphElement>(".st-error");
    expect(err.hidden).toBe(false);
    expect(err.textContent).toMatch(/адресу сайту/);
    const url = q<HTMLInputElement>('input[name="url"]');
    url.value = "z";
    url.dispatchEvent(new Event("input"));
    expect(err.hidden).toBe(true);
  });

  it(`понад ${MAX_PHOTOS} фото — помилка, фото не надсилаються`, async () => {
    const createProject = vi.fn<CreateProject>(async () => {});
    const { q, submit } = setup(createProject);
    setFiles(q<HTMLInputElement>('input[name="photos"]'), MAX_PHOTOS + 1);
    expect(q(".st-error").textContent).toContain(`до ${MAX_PHOTOS} фото`);
    expect(q(".st-photos").textContent).toBe(`+ Фото (до ${MAX_PHOTOS})`);
    setFiles(q<HTMLInputElement>('input[name="photos"]'), 2);
    expect(q<HTMLParagraphElement>(".st-error").hidden).toBe(true);
    q<HTMLInputElement>('input[name="url"]').value = "zerno.example.com";
    submit();
    await flush();
    expect(sentForm(createProject).getAll("photos")).toHaveLength(2);
  });

  it("ui.startError показується під полем і зникає", () => {
    const { q, setUi } = setup();
    const err = q<HTMLParagraphElement>(".st-error");
    setUi({ startError: "Це внутрішня або приватна адреса." });
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe("Це внутрішня або приватна адреса.");
    setUi({ startError: null });
    expect(err.hidden).toBe(true);
    expect(err.textContent).toBe("");
  });

  it("кнопка disabled, поки запит триває, і за ui.sending", async () => {
    let resolve: () => void = () => {};
    const createProject = vi.fn<CreateProject>(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const { q, submit, setUi } = setup(createProject);
    const btn = q<HTMLButtonElement>(".st-submit");
    q<HTMLInputElement>('input[name="url"]').value = "zerno.example.com";
    submit();
    expect(btn.disabled).toBe(true);
    submit();
    expect(createProject).toHaveBeenCalledOnce();
    resolve();
    await flush();
    expect(btn.disabled).toBe(false);
    setUi({ sending: true });
    expect(btn.disabled).toBe(true);
    setUi({ sending: false });
    expect(btn.disabled).toBe(false);
  });

  it("update не перестворює video, поля й textarea", () => {
    const { el, q, setUi, store } = setup();
    const before = ["video", 'input[name="url"]', 'input[name="photos"]', "textarea"].map((s) => q(s));
    q<HTMLInputElement>('input[name="url"]').value = "чернетка";
    setUi({ startError: "x", sending: true });
    setUi({ startError: null, sending: false });
    store.setState({ status: "crawling" });
    const after = ["video", 'input[name="url"]', 'input[name="photos"]', "textarea"].map((s) => q(s));
    after.forEach((node, i) => {
      expect(node).toBe(before[i]);
    });
    expect(q<HTMLInputElement>('input[name="url"]').value).toBe("чернетка");
    expect(el.querySelectorAll("video")).toHaveLength(1);
  });

  it("помилка відео → смугастий плейсхолдер 9:16", () => {
    const { q } = setup();
    const video = q<HTMLVideoElement>("video");
    video.dispatchEvent(new Event("error"));
    expect(video.hidden).toBe(true);
    expect(q(".st-frame").classList.contains("stripes")).toBe(true);
  });

  it("timeupdate рухає тайм-код і смугу", () => {
    const { q } = setup();
    const video = q<HTMLVideoElement>("video");
    Object.defineProperty(video, "duration", { configurable: true, value: 15 });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 3.4 });
    video.dispatchEvent(new Event("timeupdate"));
    expect(q(".st-time").textContent).toBe("0:03 / 0:15");
    expect(Number(q<HTMLElement>(".st-bar .bar__fill").style.getPropertyValue("--bar-value"))).toBeCloseTo(
      3.4 / 15,
    );
    expect(formatTime(75)).toBe("1:15");
  });

  it("destroy прибирає розмітку", () => {
    const { el, view } = setup();
    view.destroy();
    expect(el.childElementCount).toBe(0);
  });
});
