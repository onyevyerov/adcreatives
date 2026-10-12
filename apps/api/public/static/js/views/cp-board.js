// @ts-check
/**
 * B8 · Чекпоінт 3 — розкадровка (S4, C7).
 *
 * Шапка: eyebrow з ромбом і ревізією, «Правки» → `startEdit`, «Затвердити й рендерити →» → `approve`
 * (активні лише в `awaiting_storyboard`, поки `checkpoints.storyboard.state === "open"`). Далі —
 * «Розкадровка» і лід з основним форматом; стіли, згруповані за сценою (варіанти a, b поруч);
 * аркуші інших форматів (клік — оригінал у новій вкладці); перевірка (`warnings` за рівнями C7 і
 * примітка про шаблонні сцени); музика — кнопка play/pause над прихованим `<audio>`, 72 декоративні
 * смуги (висоти детерміновані від URL), заповнення за `currentTime`, тайм-код.
 *
 * `update` перебудовує вміст лише при новому payload/ревізії (плеєр з тим самим URL переноситься
 * без перестворення `<audio>`); зміна статусу чи стану чекпоінта лише вмикає/вимикає кнопки й
 * перемикає ромб. Тексти — лише через `textContent`, URL медіа — через `safeMediaUrl`.
 */
import { CHECKPOINT_STATUS, FORMAT_LABELS, FORMATS } from "../contracts.js";
import { clear, h, text } from "../dom.js";
import { PURPOSE_LABELS, plural, safeMediaUrl } from "./cp-script.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Format} Format */
/** @typedef {import("../contracts.js").CheckpointEntry} CheckpointEntry */
/** @typedef {import("../contracts.js").StoryboardCheckpointPayload} StoryboardCheckpointPayload */
/** @typedef {StoryboardCheckpointPayload["stills"][number]} Still */
/** @typedef {StoryboardCheckpointPayload["warnings"][number]} QaIssue */
/** @typedef {QaIssue["severity"]} Severity */
/** @typedef {{ id: string, purpose: string }} SceneInfo */

/** Кількість декоративних смуг хвильової форми. */
export const WAVE_BARS = 72;

/** Розмір стіла за основним форматом: висота з ТЗ, ширина — за пропорцією. @type {Record<Format, { width: number, height: number }>} */
export const STILL_SIZES = {
  vertical: { width: 129, height: 230 },
  square: { width: 150, height: 150 },
  landscape: { width: 199, height: 112 },
};

/** Підписи рівнів QA (C7). @type {Record<Severity, string>} */
export const SEVERITY_LABELS = { critical: "критичне", major: "серйозне", minor: "незначне" };

/** Порядок рівнів: спершу найсерйозніші. @type {Record<Severity, number>} */
const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2 };

export const QA_OK = "✓ Перевірка не знайшла проблем";
export const MUSIC_PENDING = "Музика ще генерується";

/**
 * Чи можна зараз затвердити/правити: статус `awaiting_storyboard` і відкритий чекпоінт.
 * @param {Pick<UiState, "status" | "checkpoints">} state
 */
export function isActive(state) {
  return state.status === CHECKPOINT_STATUS.storyboard && state.checkpoints.storyboard?.state === "open";
}

/**
 * Хеш FNV-1a (32 біти) рядка.
 * @param {string} s
 */
function fnv1a(s) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Висоти декоративних смуг (0.15…1), детерміновані від URL: той самий URL — та сама форма.
 * Сусідні значення згладжено, а краї трохи нижчі — щоб це читалося як хвиля, а не шум.
 * @param {string} url
 * @param {number} [count]
 * @returns {number[]}
 */
export function waveHeights(url, count = WAVE_BARS) {
  // mulberry32 від хешу URL.
  let seed = fnv1a(String(url ?? ""));
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const raw = Array.from({ length: count }, () => rand());
  return raw.map((v, i) => {
    const prev = raw[i - 1] ?? v;
    const next = raw[i + 1] ?? v;
    const smooth = (prev + 2 * v + next) / 4;
    const edge = count > 1 ? Math.sin((Math.PI * (i + 0.5)) / count) : 1;
    const value = 0.15 + 0.85 * smooth * (0.55 + 0.45 * edge);
    return Math.round(Math.min(1, Math.max(0.15, value)) * 1000) / 1000;
  });
}

/**
 * Тайм-код m:ss (7 → «0:07», 75.4 → «1:15»); не-числа й від'ємні → «0:00».
 * @param {number} seconds
 */
export function formatClock(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Частка прослуханого 0…1.
 * @param {number} current
 * @param {number} duration
 */
export function playedRatio(current, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(current)) return 0;
  return Math.min(1, Math.max(0, current / duration));
}

/**
 * Групує стіли за сценою: порядок — як у сценарії (`order`), невідомі сцени — за першою появою;
 * усередині групи — варіант a, потім b.
 * @param {readonly Still[]} stills
 * @param {readonly string[]} [order] ID сцен у порядку сценарію
 * @returns {{ sceneId: string, stills: Still[] }[]}
 */
export function groupStills(stills, order = []) {
  /** @type {Map<string, Still[]>} */
  const groups = new Map();
  for (const s of stills) {
    const list = groups.get(s.sceneId);
    if (list) list.push(s);
    else groups.set(s.sceneId, [s]);
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  const ids = [...groups.keys()];
  const known = ids.filter((id) => rank.has(id)).sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  const unknown = ids.filter((id) => !rank.has(id));
  return [...known, ...unknown].map((sceneId) => ({
    sceneId,
    stills: [...(groups.get(sceneId) ?? [])].sort((a, b) => a.variant.localeCompare(b.variant)),
  }));
}

/**
 * Підпис сцени «S1»: номер за сценарієм, інакше сам ID великими літерами.
 * @param {string} sceneId
 * @param {readonly SceneInfo[]} scenes
 */
export function sceneLabel(sceneId, scenes) {
  const i = scenes.findIndex((s) => s.id === sceneId);
  return i >= 0 ? `S${i + 1}` : sceneId.toUpperCase();
}

/**
 * Підпис стіла «S1 · хук» (без призначення, якщо сцени немає в сценарії).
 * @param {string} sceneId
 * @param {readonly SceneInfo[]} scenes
 */
export function sceneCaption(sceneId, scenes) {
  const scene = scenes.find((s) => s.id === sceneId);
  const label = sceneLabel(sceneId, scenes);
  return scene ? `${label} · ${PURPOSE_LABELS[scene.purpose] ?? scene.purpose}` : label;
}

/**
 * Лід під заголовком.
 * @param {Format} primaryFormat
 */
export function leadText(primaryFormat) {
  return `Стіли в основному форматі ${FORMAT_LABELS[primaryFormat] ?? primaryFormat} — по два кадри на сцену.`;
}

/**
 * Примітка про сцени, зібрані за шаблоном (C7); `null`, якщо таких немає.
 * @param {readonly string[]} labels підписи сцен («S3»)
 */
export function templateNote(labels) {
  if (labels.length === 0) return null;
  return `Сцени ${labels.join(", ")} не вдалося зібрати автоматично, тому вони зроблені за простим шаблоном.`;
}

/**
 * Шапка зауваження QA (C7): «S2 · 9:16 · незначне · outside_safe_area».
 * @param {QaIssue} w
 * @param {readonly SceneInfo[]} scenes
 */
export function issueHead(w, scenes) {
  return [
    sceneLabel(w.sceneId, scenes),
    FORMAT_LABELS[w.format] ?? w.format,
    SEVERITY_LABELS[w.severity] ?? w.severity,
    w.kind,
  ].join(" · ");
}

/**
 * Зауваження QA, відсортовані за рівнем (critical → minor), стабільно.
 * @param {readonly QaIssue[]} warnings
 */
export function sortWarnings(warnings) {
  return warnings
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (SEVERITY_ORDER[a.w.severity] ?? 3) - (SEVERITY_ORDER[b.w.severity] ?? 3) || a.i - b.i)
    .map((x) => x.w);
}

/**
 * Payload чекпоінта 3 зі стану або `null`.
 * @param {CheckpointEntry | null | undefined} entry
 * @returns {StoryboardCheckpointPayload | null}
 */
function boardPayloadOf(entry) {
  const p = entry?.payload;
  return p && p.checkpoint === "storyboard" ? p : null;
}

/**
 * Сцени сценарію (id, purpose) з чекпоінта 2, якщо він є.
 * @param {UiState} state
 * @returns {SceneInfo[]}
 */
function scriptScenesOf(state) {
  const p = state.checkpoints.script?.payload;
  return p && p.checkpoint === "script"
    ? p.storyboard.scenes.map((s) => ({ id: s.id, purpose: s.purpose }))
    : [];
}

/**
 * Рядок специфікації з міткою.
 * @param {string} cls
 * @param {string} label
 * @param {...import("../dom.js").Child} children
 */
function specRow(cls, label, ...children) {
  return h(
    "div",
    { class: `spec-row ${cls}` },
    h("span", { class: "spec-row__label", text: label }),
    h("div", { class: "cd-row__body" }, ...children),
  );
}

/**
 * Стіли, згруповані за сценою.
 * @param {StoryboardCheckpointPayload} payload
 * @param {readonly SceneInfo[]} scenes
 */
function stillsGrid(payload, scenes) {
  const size = STILL_SIZES[payload.primaryFormat] ?? STILL_SIZES.vertical;
  const changed = new Set(payload.changedScenes ?? []);
  const template = new Set(payload.templateScenes);
  const groups = groupStills(
    payload.stills,
    scenes.map((s) => s.id),
  );
  return h(
    "ol",
    { class: "cd-stills", "data-format": payload.primaryFormat, "aria-label": "Стіли сцен" },
    groups.map((g) => {
      const caption = sceneCaption(g.sceneId, scenes);
      return h(
        "li",
        {
          class: `cd-scene${changed.has(g.sceneId) ? " cd-scene--changed" : ""}`,
          "data-scene": g.sceneId,
        },
        h(
          "div",
          { class: "cd-scene__frames" },
          g.stills.map((s) => {
            const url = safeMediaUrl(s.url);
            const attrs = {
              class: "cd-still",
              "data-variant": s.variant,
              width: size.width,
              height: size.height,
            };
            return url
              ? h("img", {
                  ...attrs,
                  src: url,
                  alt: `${caption}, кадр ${s.variant.toUpperCase()}`,
                  loading: "lazy",
                  decoding: "async",
                })
              : h("div", {
                  ...attrs,
                  class: "cd-still stripes",
                  role: "img",
                  "aria-label": "Немає зображення",
                });
          }),
        ),
        h(
          "p",
          { class: "cd-scene__caption" },
          h("span", { class: "label-s cd-scene__label", text: caption }),
          changed.has(g.sceneId)
            ? h("span", { class: "label-s cd-tag cd-tag--changed", text: "змінено" })
            : null,
          template.has(g.sceneId)
            ? h("span", { class: "label-s cd-tag cd-tag--template", text: "шаблон" })
            : null,
        ),
      );
    }),
  );
}

/**
 * Аркуші інших форматів: рядок на формат, клік — оригінал у новій вкладці.
 * @param {StoryboardCheckpointPayload} payload
 */
function sheetsRow(payload) {
  const sheets = payload.sheets
    .map((s) => ({ format: s.format, url: safeMediaUrl(s.url) }))
    .filter(/** @returns {s is { format: Format, url: string }} */ (s) => s.url !== null)
    .sort((a, b) => FORMATS.indexOf(a.format) - FORMATS.indexOf(b.format));
  if (sheets.length === 0) return null;
  return specRow(
    "cd-sheets",
    "Аркуші",
    h(
      "ul",
      { class: "cd-sheets__list" },
      sheets.map((s) => {
        const label = FORMAT_LABELS[s.format] ?? s.format;
        return h(
          "li",
          { class: "cd-sheet", "data-format": s.format },
          h("span", { class: "mono cd-sheet__format", text: label }),
          h(
            "a",
            {
              class: "cd-sheet__link",
              href: s.url,
              target: "_blank",
              rel: "noopener noreferrer",
              title: `Аркуш ${label} — відкрити оригінал`,
            },
            h("img", {
              class: "cd-sheet__img",
              src: s.url,
              alt: `Аркуш сцен у форматі ${label}`,
              loading: "lazy",
              decoding: "async",
            }),
            h("span", { class: "mono cd-sheet__hint", text: "оригінал ↗" }),
          ),
        );
      }),
    ),
  );
}

/**
 * Перевірка (C7): зауваження за рівнями + примітка про шаблонні сцени.
 * @param {StoryboardCheckpointPayload} payload
 * @param {readonly SceneInfo[]} scenes
 */
function qaRow(payload, scenes) {
  const warnings = sortWarnings(payload.warnings);
  const note = templateNote(payload.templateScenes.map((id) => sceneLabel(id, scenes)));
  return specRow(
    "cd-qa",
    "Перевірка",
    warnings.length === 0
      ? h("p", { class: "cd-qa-ok", text: QA_OK })
      : h(
          "ul",
          { class: "cd-qa__list" },
          warnings.map((w) =>
            h(
              "li",
              { class: "cd-issue", "data-severity": w.severity, "data-scene": w.sceneId },
              h("p", { class: "cd-issue__head", text: issueHead(w, scenes) }),
              // `fix` у референсі не показано — лише підказка при наведенні.
              h("p", {
                class: "cd-issue__desc",
                text: w.description,
                title: w.fix ? `Як виправити: ${w.fix}` : null,
              }),
            ),
          ),
        ),
    note ? h("p", { class: "cd-note", text: note }) : null,
  );
}

/**
 * Плеєр музики: кнопка 44 px, прихований `<audio>`, декоративна хвиля, тайм-код.
 * @param {string} url безпечний URL
 */
function createPlayer(url) {
  const icon = h("span", { class: "icon-play", "aria-hidden": "true" });
  const button = h(
    "button",
    {
      type: "button",
      class: "btn-round btn-round--44 cd-play",
      "aria-label": "Відтворити музику",
      "aria-pressed": "false",
    },
    icon,
  );
  const audio = h("audio", { class: "cd-audio", src: url, preload: "metadata", hidden: true });
  const bars = waveHeights(url).map((v) => h("span", { class: "cd-wave__bar", style: { "--h": String(v) } }));
  const wave = h("div", { class: "cd-wave", "aria-hidden": "true" }, bars);
  const time = h("span", { class: "mono cd-time", text: "0:00 / 0:00" });
  const node = h("div", { class: "cd-player", "data-state": "paused" }, button, wave, time, audio);

  let playing = false;
  let played = 0;

  function syncButton() {
    icon.className = playing ? "icon-pause" : "icon-play";
    button.setAttribute("aria-label", playing ? "Пауза" : "Відтворити музику");
    button.setAttribute("aria-pressed", playing ? "true" : "false");
    node.dataset.state = playing ? "playing" : "paused";
  }

  function syncProgress() {
    const ratio = playedRatio(audio.currentTime, audio.duration);
    const n = Math.round(ratio * bars.length);
    if (n !== played) {
      bars.forEach((b, i) => {
        b.classList.toggle("is-played", i < n);
      });
      played = n;
    }
    text(time, `${formatClock(audio.currentTime)} / ${formatClock(audio.duration)}`);
  }

  /** @type {[string, () => void][]} */
  const listeners = [
    ["timeupdate", syncProgress],
    ["loadedmetadata", syncProgress],
    [
      "play",
      () => {
        playing = true;
        syncButton();
      },
    ],
    [
      "pause",
      () => {
        playing = false;
        syncButton();
        syncProgress();
      },
    ],
    [
      "ended",
      () => {
        playing = false;
        syncButton();
        syncProgress();
      },
    ],
  ];
  for (const [type, fn] of listeners) audio.addEventListener(type, fn);

  const onClick = () => {
    if (playing) {
      audio.pause();
      return;
    }
    try {
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch((/** @type {unknown} */ err) => console.warn("[cp-board] play", err));
      }
    } catch (err) {
      console.warn("[cp-board] play", err);
    }
  };
  button.addEventListener("click", onClick);

  return {
    url,
    node,
    audio,
    destroy() {
      try {
        audio.pause();
      } catch {
        // середовище без медіа — нічого зупиняти
      }
      for (const [type, fn] of listeners) audio.removeEventListener(type, fn);
      button.removeEventListener("click", onClick);
      node.remove();
    },
  };
}

/** @typedef {ReturnType<typeof createPlayer>} Player */

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  let pending = false;
  let destroyed = false;
  /** @type {Player | null} */
  let player = null;

  const diamond = h("span", { class: "diamond", "aria-hidden": "true" });
  const eyebrow = h("span", { class: "cd-eyebrow__text" });
  const editBtn = h("button", {
    type: "button",
    class: "btn btn--ghost cd-edit",
    "data-action": "edit",
    text: "Правки",
  });
  const approveBtn = h(
    "button",
    { type: "button", class: "btn btn--primary cd-approve", "data-action": "approve" },
    "Затвердити й рендерити",
    h("span", { class: "btn__arrow", "aria-hidden": "true", text: "→" }),
  );
  const body = h("div", { class: "cd-body" });
  const root = h(
    "section",
    { class: "cd adc-enter", "aria-label": "Чекпоінт 3 — розкадровка" },
    h(
      "header",
      { class: "cd-head" },
      h("p", { class: "eyebrow cd-eyebrow" }, diamond, eyebrow),
      h("div", { class: "cd-actions" }, editBtn, approveBtn),
    ),
    body,
  );
  el.append(root);

  editBtn.addEventListener("click", () => {
    if (editBtn.disabled || !isActive(ctx.store.getState())) return;
    ctx.actions.startEdit();
  });
  approveBtn.addEventListener("click", async () => {
    if (approveBtn.disabled || pending || !isActive(ctx.store.getState())) return;
    pending = true;
    syncControls(ctx.store.getState());
    try {
      await ctx.actions.approve();
    } catch (err) {
      console.error("[cp-board] approve", err);
    } finally {
      pending = false;
      if (!destroyed) syncControls(ctx.store.getState());
    }
  });

  /** @param {UiState} state */
  function syncControls(state) {
    const active = isActive(state);
    editBtn.disabled = !active;
    approveBtn.disabled = !active || pending;
    const st = state.checkpoints.storyboard?.state;
    diamond.classList.toggle("diamond--open", active);
    diamond.classList.toggle("diamond--ring", active);
    diamond.classList.toggle("diamond--done", st === "approved");
    diamond.classList.toggle("diamond--stale", st === "superseded");
    root.dataset.state = active ? "open" : (st ?? "none");
  }

  /**
   * Рядок музики: плеєр з тим самим URL переноситься, інакше — новий.
   * @param {StoryboardCheckpointPayload} payload
   */
  function musicRow(payload) {
    const url = payload.music ? safeMediaUrl(payload.music.url) : null;
    if (player && player.url !== url) {
      player.destroy();
      player = null;
    }
    if (url && !player) player = createPlayer(url);
    return specRow(
      "cd-music",
      "Музика",
      player ? player.node : h("p", { class: "mono cd-music-pending", text: MUSIC_PENDING }),
    );
  }

  /** @param {UiState} state */
  function rebuild(state) {
    const entry = state.checkpoints.storyboard;
    const payload = boardPayloadOf(entry);
    text(eyebrow, `Чекпоінт 3 / 3 · Розкадровка${entry ? ` · ревізія ${entry.rev}` : ""}`);
    if (player) player.node.remove();
    clear(body);
    if (!payload) {
      player?.destroy();
      player = null;
      body.append(h("p", { class: "body-l cd-empty", text: "Розкадровка ще не надійшла." }));
      return;
    }
    const scenes = scriptScenesOf(state);
    const changed = payload.changedScenes ?? [];
    const n = changed.length;
    body.append(
      h(
        "div",
        { class: "cd-intro" },
        h("h1", { class: "display-m cd-title", text: "Розкадровка" }),
        h("p", { class: "body-l cd-lead", text: leadText(payload.primaryFormat) }),
        n > 0
          ? h("p", {
              class: "mono cd-changed-note",
              text: `Після правки ${plural(n, ["змінено сцену", "змінено сцени", "змінено сцен"])} ${changed
                .map((id) => sceneLabel(id, scenes))
                .join(", ")}; решта — без змін.`,
            })
          : null,
      ),
      payload.stills.length > 0
        ? stillsGrid(payload, scenes)
        : h("p", { class: "mono cd-stills-empty", text: "Стілів у цій ревізії немає." }),
    );
    const sheets = sheetsRow(payload);
    if (sheets) body.append(sheets);
    body.append(qaRow(payload, scenes), musicRow(payload));
  }

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    const entry = state.checkpoints.storyboard;
    const before = prev?.checkpoints.storyboard;
    if (
      !prev ||
      entry?.payload !== before?.payload ||
      entry?.rev !== before?.rev ||
      state.checkpoints.script?.payload !== prev.checkpoints.script?.payload
    ) {
      rebuild(state);
    }
    if (
      !prev ||
      state.status !== prev.status ||
      entry?.state !== before?.state ||
      entry?.rev !== before?.rev
    ) {
      syncControls(state);
    }
  }

  render(ctx.store.getState(), null);

  return {
    update: (state, prev) => render(state, prev),
    destroy() {
      destroyed = true;
      player?.destroy();
      player = null;
      root.remove();
    },
  };
}
