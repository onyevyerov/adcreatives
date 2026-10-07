// @ts-check
/**
 * B2 · Mock-бекенд для `?mock=1`: програє `static/dev/fixture-events.js` посегментно через той
 * самий `reduce`, без мережі. Фікстура імпортується динамічно — лише в mock-режимі.
 *
 * Сценарій:
 * - старт (createProject) → echo адреси → `toBrand`;
 * - «Затвердити»: awaiting_brand → `toScript`; awaiting_script → `toStoryboard` (з `?fail=1` —
 *   один раз `failed`); awaiting_storyboard → `toDelivered`, а для ревізії 2 — `revisionDelivered`;
 * - «Спробувати ще раз» у failed → `retry`;
 * - повідомлення: echo; у delivered (ревізія 1) → `revisionAfterDelivery` (без її власного
 *   повідомлення клієнта), інакше — коротка відповідь асистента («Записав: …»);
 * - `?jump=brand|script|storyboard|delivered|failed|revision|revisionDelivered` — миттєво
 *   застосовує `PATHS[jump]`; `?speed=2` — удвічі швидше.
 *
 * Пауза між подіями сегмента = min(Δ`at`, 2,5 с) / speed; перша подія сегмента — 0,4 с / speed.
 */
import { reduce, reduceAll } from "./reduce.js";

/** @typedef {import("../contracts.js").ChatEvent} ChatEvent */
/** @typedef {import("../contracts.js").Store} Store */
/** @typedef {import("../../dev/fixture-events.js").StoredEvent} StoredEvent */
/** @typedef {typeof import("../../dev/fixture-events.js")} Fixture */
/** @typedef {import("../../dev/fixture-events.js").PathName} PathName */
/** @typedef {import("./actions.js").Backend} Backend */
/** @typedef {import("@adc/shared/schemas").ChatEventInput} ChatEventInput */

/** Пауза перед першою подією сегмента, мс (до ділення на speed). */
export const FIRST_DELAY_MS = 400;
/** Стеля паузи між подіями сегмента, мс (до ділення на speed). */
export const GAP_CAP_MS = 2500;
/** Пауза перед відповіддю асистента на повідомлення, мс (до ділення на speed). */
export const ACK_DELAY_MS = 700;
/** Імітація мережі для createProject, мс (до ділення на speed). */
export const CREATE_DELAY_MS = 300;

/**
 * @param {Store} store
 * @param {{ params: URLSearchParams }} opts
 * @returns {Backend}
 */
export function createMockBackend(store, { params }) {
  const speed = Math.min(50, Math.max(0.1, Number(params.get("speed")) || 1));
  const failOnScript = params.get("fail") === "1";
  /** @type {Promise<Fixture>} */
  const fixture = import("../../dev/fixture-events.js");
  /** `?jump=` діє лише на першому старті. */
  let jump = params.get("jump");

  /** @type {{ delay: number, make: () => StoredEvent }[]} */
  let queue = [];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {string | null} */
  let lastAt = null;
  let seq = 0;
  /** Текст, з яким створено проєкт (echo як у бекенді). @type {string | null} */
  let intakeText = null;
  let failedOnce = false;
  let revised = false;
  /** Покоління сесії: stop() робить застарілими відкладені дії попередньої. */
  let session = 0;

  /** @param {number} ms */
  const scaled = (ms) => Math.round(ms / speed);

  /** @param {StoredEvent} stored */
  function apply({ id, event }) {
    store.setState((s) => reduce(s, event, id));
    lastAt = event.at;
  }

  /**
   * Синтетична подія (echo, відповідь): `at` — на секунду після останньої програної.
   * @param {ChatEventInput} draft
   * @returns {StoredEvent}
   */
  function synth(draft) {
    const base = lastAt ? Date.parse(lastAt) : Date.now();
    const at = new Date(base + 1000).toISOString();
    lastAt = at;
    return { id: `mock-${++seq}`, event: /** @type {ChatEvent} */ ({ ...draft, at }) };
  }

  function pump() {
    const next = queue[0];
    if (timer !== undefined || !next) return;
    timer = setTimeout(() => {
      timer = undefined;
      const item = queue.shift();
      if (item) apply(item.make());
      pump();
    }, scaled(next.delay));
  }

  /** @param {StoredEvent[]} events */
  function play(events) {
    let prevAt = null;
    for (const stored of events) {
      const at = Date.parse(stored.event.at);
      const delay = prevAt === null ? FIRST_DELAY_MS : Math.min(Math.max(0, at - prevAt), GAP_CAP_MS);
      prevAt = at;
      queue.push({ delay, make: () => stored });
    }
    pump();
  }

  /** @param {string} text @param {number} [delay] */
  function reply(text, delay = ACK_DELAY_MS) {
    queue.push({ delay, make: () => synth({ type: "message", role: "assistant", text }) });
    pump();
  }

  /** @param {string} text */
  function echo(text) {
    apply(synth({ type: "message", role: "user", text }));
  }

  const busy = () => timer !== undefined || queue.length > 0;

  /** @param {string} text */
  function ackFor(text) {
    const formats = /^Формати:\s*(.+)$/.exec(text);
    if (formats) return `Записав: формати — ${formats[1]}.`;
    const lang = /^Мова відео:\s*(.+)$/.exec(text);
    if (lang) return `Записав: мова відео — ${lang[1]}.`;
    return "Записав. (Демо-режим: правки не застосовуються, програю лише фікстуру.)";
  }

  return {
    async start(projectId) {
      const my = session;
      const fx = await fixture;
      if (my !== session) return;
      const boot = intakeText === null;
      store.setState((s) => ({
        route: "project",
        projectId: projectId || s.projectId || fx.PROJECT_ID,
        site: boot ? (s.site ?? fx.SITE_HOST) : s.site,
        conn: "online",
      }));
      const path = jump && Object.hasOwn(fx.PATHS, jump) ? fx.PATHS[/** @type {PathName} */ (jump)] : null;
      if (jump && !path) console.warn(`[mock] немає шляху «${jump}»: ${Object.keys(fx.PATHS).join(", ")}`);
      jump = null;
      if (path) {
        const events = fx.eventsOf(path);
        store.setState((s) => reduceAll(s, events));
        lastAt = events.at(-1)?.event.at ?? null;
        failedOnce = path.includes("failed");
        revised = path.includes("revisionAfterDelivery");
        return;
      }
      const first = fx.segments.toBrand[0];
      if (intakeText) {
        // Echo адреси — за 2 с до першої події фікстури, щоб час у стрічці йшов по порядку.
        if (first) lastAt = new Date(Date.parse(first.event.at) - 3000).toISOString();
        echo(intakeText);
      }
      play(fx.segments.toBrand);
    },

    stop() {
      session++;
      clearTimeout(timer);
      timer = undefined;
      queue = [];
      lastAt = null;
      intakeText = null;
      failedOnce = false;
      revised = false;
    },

    async createProject(form) {
      const fx = await fixture;
      const field = (/** @type {string} */ name) => {
        const v = form.get(name);
        return typeof v === "string" ? v.trim() : "";
      };
      const url = field("url");
      const manualText = field("manualText");
      if (!url && !manualText) throw new Error("Вставте адресу сайту або напишіть кілька речень про бізнес.");
      const photos = form.getAll("photos").filter((f) => typeof f !== "string" && f.size > 0).length;
      await new Promise((resolve) => setTimeout(resolve, scaled(CREATE_DELAY_MS)));
      intakeText = [url || manualText, photos > 0 ? `Фото: ${photos}` : ""].filter(Boolean).join("\n");
      return fx.PROJECT_ID;
    },

    async sendMessage(_projectId, text) {
      const fx = await fixture;
      echo(text);
      if (busy()) return;
      const { status } = store.getState();
      if (status === "delivered" && !revised) {
        revised = true;
        // Власне повідомлення клієнта з фікстури замінює щойно надіслане.
        play(
          fx.segments.revisionAfterDelivery.filter(
            ({ event }) => event.type !== "message" || event.role !== "user",
          ),
        );
        return;
      }
      reply(ackFor(text));
    },

    async sendCommand(_projectId, body) {
      const fx = await fixture;
      const { status, rev } = store.getState();
      switch (body.type) {
        case "approve":
          if (busy()) return;
          if (status === "awaiting_brand") play(fx.segments.toScript);
          else if (status === "awaiting_script") {
            if (failOnScript && !failedOnce) {
              failedOnce = true;
              play(fx.segments.failed);
            } else play(fx.segments.toStoryboard);
          } else if (status === "awaiting_storyboard") {
            play((rev ?? 1) >= 2 ? fx.segments.revisionDelivered : fx.segments.toDelivered);
          }
          return;
        case "retry":
          if (!busy() && status === "failed") play(fx.segments.retry);
          return;
        case "set_logo":
          reply(`Записав: лого — ${body.assetId}.`);
          return;
        case "restart_confirmed":
          reply("Демо-режим: перезапуск пропущено. Почніть новий проєкт, щоб програти фікстуру спочатку.");
          return;
      }
    },

    async uploadPhotos(_projectId, files) {
      await fixture;
      echo(`Додаю фото: ${files.map((f) => f.name).join(", ")}`);
      reply("Дякую, фото додано.");
    },
  };
}
