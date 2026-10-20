// @ts-check
/**
 * B9 · фікстури N12: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` з `./_base.js` (Олена, 4 проєкти з `credits`).
 *
 * - `cab-projects` — кадр `#N11` «Мої проєкти» (1440);
 * - `sheet-n12-*` — клітинки аркуша `sheet-n12` у його порядку: «Список · 4» (`-list`),
 *   «Розбивка · zerno» (`-zerno`), «Розбивка з поверненням» (`-refund`), «Порожньо» (`-empty`),
 *   «Один проєкт» (`-one`), «Без постера» (`-no-poster`; постера в реалізації немає — той самий
 *   список), «12 проєктів · стрес-тест» (`-stress`).
 * Клітинки аркуша в Референсі — лише розділ; фікстура — уся сторінка кабінету з тим самим розділом.
 */
import { accountFixture, at, PROJECTS } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").CabinetState} CabinetState */
/** @typedef {import("../../js/contracts.js").ProjectRow} ProjectRow */
/** @typedef {import("../../js/contracts.js").ProjectStatus} ProjectStatus */
/** @typedef {import("./_base.js").StatePatch} StatePatch */

/**
 * Кабінет на «Моїх проєктах»; `rows` (і `projectCount`) — інший список.
 * @param {Partial<CabinetState["projects"]>} [projects]
 * @returns {UiState}
 */
const projects = (projects = {}) =>
  accountFixture(
    /** @type {StatePatch} */ ({
      route: "cabinet",
      cabinet: { section: "projects", projects },
      ...(projects.rows ? { account: { projectCount: projects.rows.length } } : {}),
    }),
  );

const HOSTS = [
  "florist-kyiv.example.com",
  null,
  "shyna-lviv.example.com",
  "zerno.example.com",
  "barbershop-lviv.example.com",
  "pekarnia-dnipro.example.com",
  null,
  "yoga-studio-odesa.example.com",
  "avtomyika.example.com",
  "kvity-na-rynku.example.com",
  "kava-z-soboyu.example.com",
  "remont-telefoniv.example.com",
];
/** @type {ProjectStatus[]} */
const STATUSES = [
  "rendering",
  "awaiting_script",
  "failed",
  "delivered",
  "delivered",
  "awaiting_brand",
  "directing",
  "delivered",
  "revising",
  "awaiting_storyboard",
  "intake",
  "delivered",
];
const DAYS = [
  "19.10",
  "19.10",
  "18.10",
  "18.10",
  "17.10",
  "17.10",
  "16.10",
  "16.10",
  "15.10",
  "15.10",
  "14.10",
  "14.10",
];

/** 12 проєктів для стрес-тесту (як `long` в AcApp): формати й кредити — з 4 базових по колу. @type {ProjectRow[]} */
export const MANY = HOSTS.map((site, i) => {
  const base = /** @type {ProjectRow} */ (PROJECTS[i % 4]);
  return {
    ...base,
    id: `p_x${i}`,
    site,
    status: /** @type {ProjectStatus} */ (STATUSES[i]),
    createdAt: at(`${DAYS[i]} 10:00`),
    chatUrl: `/?project=p_x${i}`,
  };
});

/** @type {Record<string, UiState>} */
export default {
  // ───── Кадр #N11 «Мої проєкти» ─────
  "cab-projects": projects(),

  // ───── Аркуш sheet-n12 ─────
  "sheet-n12-list": projects(),
  "sheet-n12-zerno": projects({ open: "p_zerno" }),
  "sheet-n12-refund": projects({ open: "p_shyna" }),
  "sheet-n12-empty": projects({ rows: [] }),
  "sheet-n12-one": projects({ rows: PROJECTS.slice(3, 4) }),
  "sheet-n12-no-poster": projects(),
  "sheet-n12-stress": projects({ rows: MANY }),
};
