// @ts-check
/**
 * B6 · фікстури N6–N7: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` / `workspaceFixture()` з `./_base.js`.
 *
 * Робочий простір «Зерна» (шлях подій fixture-events.js) + події білінгу, дописані тим самим
 * редьюсером: бекенд шле відмови, списання й повернення звичайними повідомлениями `assistant`
 * з текстами `packages/shared/src/i18n/uk.ts` (`CREDIT_TEMPLATES`).
 *
 * - `n7-fmt-short` / `n7-rev-short` — відмова на ЧП3 (формати) / на правку + K3;
 * - `n6-retry` / `n6-retry-rev` — ті самі після оплати: `ui.retry` (кладе B8) → «Повторити»;
 * - `n7-rev` / `n7-fmt` / `n7-refund` — списання за правку / формати, повернення за збій.
 */
import { reduceAll } from "../../js/data/reduce.js";
import { CREDIT_TEMPLATES } from "../../js/lib/credit-messages.js";
import { meOf, OLENA, workspaceFixture } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").ChatEvent} ChatEvent */
/** @typedef {import("../../js/contracts.js").ProjectCredits} ProjectCredits */
/** @typedef {import("../../js/contracts.js").ProjectStatus} ProjectStatus */
/** @typedef {ChatEvent extends infer E ? E extends { at: string } ? Omit<E, "at"> : never : never} Draft */

/**
 * Текст шаблону uk.ts з підставленими числами.
 * @param {keyof typeof CREDIT_TEMPLATES} key
 * @param {Record<string, number>} vars
 */
const billing = (key, vars) => CREDIT_TEMPLATES[key].replace(/\{([a-z]+)\}/g, (_, k) => String(vars[k]));

/** @param {string} text @returns {Draft} */
const say = (text) => ({ type: "message", role: "assistant", text });
/** @param {string} text @returns {Draft} */
const user = (text) => ({ type: "message", role: "user", text });
/** @param {ProjectStatus} status @param {ProjectStatus} prev @param {number} rev @returns {Draft} */
const state = (status, prev, rev) => ({ type: "state", status, prev, rev });
/** @param {import("@adc/shared/schemas").CostStage} stage @param {string} label @returns {Draft} */
const progress = (stage, label) => ({ type: "progress", stage, label, done: null, total: null });

/**
 * Дописує події після останньої події шляху (ID і час — далі за стрімом). `live` — стан, що
 * триває (revising / rendering): події — щойно, щоб машинний час у таймлайні був реальним, а
 * не різницею з датою шляху.
 * @param {UiState} s
 * @param {Draft[]} drafts
 * @param {{ live?: boolean }} [o]
 * @returns {UiState}
 */
function more(s, drafts, o = {}) {
  const last = s.feed.at(-1);
  let t = o.live ? Date.now() - drafts.length * 20_000 : last ? Date.parse(last.at) : Date.now();
  return reduceAll(
    s,
    drafts.map((d) => {
      t += 20_000;
      return { id: `${t}-0`, event: /** @type {ChatEvent} */ ({ ...d, at: new Date(t).toISOString() }) };
    }),
  );
}

/** @param {number} balance @param {{ credits: number, key: number }} [delta] */
const olena = (balance, delta) => ({ me: meOf(OLENA, balance), ...(delta ? { delta } : {}) });

/** Списано лише ролик (формати ще не оплачені). @type {ProjectCredits} */
const VIDEO_ONLY = { charged: 10, refunded: 0, parts: [{ kind: "video", credits: -10 }] };

/** Ролик і 1:1. @type {ProjectCredits} */
const VIDEO_SQUARE = {
  charged: 12,
  refunded: 0,
  parts: [
    { kind: "video", credits: -10 },
    { kind: "format", credits: -2, format: "square" },
  ],
};

const EDIT = "Зроби заголовок коротшим";

/** ЧП3 «Зерна» (9:16 + 1:1): «Затвердити» → відмова за формати. @param {number} balance @param {UiState["ui"]["retry"]} retry */
const fmtShort = (balance, retry) =>
  more(
    workspaceFixture("storyboard", {
      account: olena(balance),
      projectCredits: VIDEO_ONLY,
      ui: { retry },
    }),
    [say(billing("insufficientCreditsFormats", { need: 2, have: 1 }))],
  );

/** «Готово» → правка → відмова. @param {number} balance @param {UiState["ui"]["retry"]} retry */
const revShort = (balance, retry) =>
  more(
    workspaceFixture("delivered", {
      account: olena(balance),
      projectCredits: VIDEO_SQUARE,
      ui: { retry },
    }),
    [user(EDIT), say(billing("insufficientCredits", { need: 3, have: 2 }))],
  );

/** @type {Record<string, UiState>} */
export default {
  "n7-fmt-short": fmtShort(1, null),
  "n7-rev-short": revShort(2, null),
  "n6-retry": fmtShort(11, { ctx: "cp3", plus: 10, text: null }),
  "n6-retry-rev": revShort(12, { ctx: "rev", plus: 10, text: EDIT }),

  "n7-rev": more(
    workspaceFixture("delivered", {
      account: olena(9, { credits: -3, key: 1 }),
      projectCredits: {
        charged: 15,
        refunded: 0,
        parts: [...VIDEO_SQUARE.parts, { kind: "revision", credits: -3, rev: 2 }],
      },
    }),
    [
      user(EDIT),
      state("revising", "delivered", 2),
      say(billing("chargedRevision", { credits: 3, balance: 9 })),
      progress("revise", "Вношу правки…"),
    ],
    { live: true },
  ),

  "n7-fmt": more(
    workspaceFixture("storyboard", {
      account: olena(10, { credits: -2, key: 2 }),
      projectCredits: VIDEO_SQUARE,
    }),
    [
      state("rendering", "awaiting_storyboard", 1),
      say(billing("chargedFormats", { credits: 2, count: 1, balance: 10 })),
      progress("render", "Рендерю відео (9:16, 1:1)…"),
    ],
    { live: true },
  ),

  "n7-refund": more(
    workspaceFixture("script", {
      site: "shyna-lviv.example.com",
      account: olena(10, { credits: 10, key: 3 }),
      projectCredits: {
        charged: 10,
        refunded: 10,
        parts: [
          { kind: "video", credits: -10 },
          { kind: "refund", credits: 10 },
        ],
      },
    }),
    [
      state("directing", "awaiting_script", 1),
      progress("codegen", "Генерую сцени… 2/3"),
      state("failed", "directing", 1),
      {
        type: "error",
        stage: "codegen",
        message: "сцену не вдалося зібрати навіть за шаблоном.",
        retryable: false,
      },
      say(billing("refundedFailure", { credits: 10 })),
    ],
  ),
};
