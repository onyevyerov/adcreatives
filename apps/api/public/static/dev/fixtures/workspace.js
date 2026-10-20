// @ts-check
/**
 * B5 · фікстури N5: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` / `workspaceFixture()` з `./_base.js`.
 *
 * Як у кадрах (`AcApp.dc.html`): Олена з балансом 12 (нестача — 1 на ЧП, 2 після видачі);
 * ЧП1 і ЧП3 — 9:16 + 1:1, крім `*-one` (лише 9:16) і `n5-cp3-paid` (ревізія 2, усі три
 * формати, 1:1 оплачено раніше — `projectCredits` з частиною `format`).
 */
import { MEDIA } from "../fixture-events.js";
import { meOf, OLENA, workspaceFixture } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").Format} Format */

/** @param {number} balance */
const olena = (balance) => ({ account: { me: meOf(OLENA, balance) } });

/** Формати на ЧП1 (вибір у payload бренд-кіта). @param {Format[]} formats */
const brandFormats = (formats) => ({ checkpoints: { brand: { payload: { formats } } } });

/** Формати на ЧП3: основний 9:16 + аркуш на кожен інший формат. @param {Format[]} others */
const boardSheets = (others) => ({
  checkpoints: {
    storyboard: { payload: { sheets: others.map((format) => ({ format, url: MEDIA.sheetSquare })) } },
  },
});

/**
 * Чекпоінт 3 у ревізії 2: і в сцені, і картка в чаті (інакше картка ревізії 1 — «замінена»).
 * @param {UiState} s
 * @returns {UiState}
 */
const boardRev2 = (s) => ({
  ...s,
  feed: s.feed.map((item) =>
    item.kind === "checkpoint" && item.checkpoint === "storyboard" ? { ...item, rev: 2 } : item,
  ),
});

/** @type {Record<string, UiState>} */
export default {
  "n5-cp1": workspaceFixture("brand", brandFormats(["vertical", "square"])),
  "n5-cp1-short": workspaceFixture("brand", { ...brandFormats(["vertical", "square"]), ...olena(1) }),
  "n5-cp1-one": workspaceFixture("brand", brandFormats(["vertical"])),

  "n5-cp3": workspaceFixture("storyboard", boardSheets(["square"])),
  "n5-cp3-short": workspaceFixture("storyboard", { ...boardSheets(["square"]), ...olena(1) }),
  "n5-cp3-paid": boardRev2(
    workspaceFixture("storyboard", {
      rev: 2,
      checkpoints: {
        storyboard: {
          rev: 2,
          payload: {
            sheets: [
              { format: "square", url: MEDIA.sheetSquare },
              { format: "landscape", url: MEDIA.sheetSquare },
            ],
          },
        },
      },
      projectCredits: {
        charged: 12,
        refunded: 0,
        parts: [
          { kind: "video", credits: -10 },
          { kind: "format", credits: -2, format: "square" },
        ],
      },
    }),
  ),
  "n5-cp3-one": workspaceFixture("storyboard", boardSheets([])),

  "n5-done": workspaceFixture("delivered"),
  "n5-done-short": workspaceFixture("delivered", olena(2)),
  "n5-done-typing": workspaceFixture("delivered", { ui: { draft: "Зроби заголовок коротшим" } }),
};
