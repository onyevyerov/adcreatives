// @ts-check
/**
 * B7 · Чекпоінт 2 — тексти (S3, X3).
 *
 * Шапка: eyebrow з ромбом і ревізією, «Правки» → `startEdit`, «Затвердити →» → `approve` (активні
 * лише в `awaiting_script`, поки `checkpoints.script.state === "open"`). Далі — концепт, хук і мета;
 * трек сцен пропорційно таймлайну (`lib/scene-track.js`) зі шкалою секунд; статус тверджень
 * (`claims.unverified`); рядки сцен; музика; мініатюри.
 *
 * Службове для власника — лише українською: «Рух» = `scene.motionNote` (немає — рядка немає,
 * англійський `motionIntent` не показуємо), музика = `musicNote ?? musicBrief.genre`, факти — тексти
 * підтверджених тверджень сцени, звук — українська назва cue. Англійською лишаються тільки тексти
 * в кадрі (headline/sub), якщо мова відео en.
 *
 * `update` перебудовує вміст лише при новому payload/ревізії; зміна статусу чи стану чекпоінта
 * лише вмикає/вимикає кнопки й перемикає ромб. Тексти — лише через `textContent`.
 */
import { CHECKPOINT_STATUS } from "../contracts.js";
import { clear, h, text } from "../dom.js";
import { formatSeconds, secondMarks, trackLayout, tryTimeline } from "../lib/scene-track.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").ScriptCheckpointPayload} ScriptCheckpointPayload */
/** @typedef {import("../contracts.js").CheckpointEntry} CheckpointEntry */
/** @typedef {ScriptCheckpointPayload["storyboard"]["scenes"][number]} Scene */
/** @typedef {ScriptCheckpointPayload["claims"]["unverified"][number]} Claim */
/** @typedef {import("../lib/scene-track.js").Timeline} Timeline */

/** Підписи призначення сцени (`ScenePurpose`). @type {Record<string, string>} */
export const PURPOSE_LABELS = {
  hook: "хук",
  problem: "проблема",
  offer: "пропозиція",
  benefit: "перевага",
  proof: "доказ",
  product: "продукт",
  brand: "бренд",
  cta: "заклик",
};

/** Підписи переходу на вході (`TransitionKind`). @type {Record<string, string>} */
export const TRANSITION_LABELS = {
  cut: "склейка",
  fade: "розчинення",
  slide: "зсув",
  wipe: "шторка",
  zoom: "наїзд",
};

/** Українські назви стандартних звуків (`SoundCue`) для застарілого `sfxCue`. @type {Record<string, string>} */
export const SFX_LABELS = {
  whoosh: "проліт",
  swoosh: "змах",
  riser: "наростання",
  impact: "удар",
  slam: "гучний удар",
  pop: "поп",
  ding: "дзвіночок",
  tick: "тікання",
  click: "клік",
  shimmer: "мерехтіння",
  drop: "басовий удар",
  error: "помилка",
  alert: "сигнал уваги",
  glitch: "збій",
  scratch: "скретч",
  typing: "друк",
  notify: "сповіщення",
  scan: "сканування",
  swipe: "свайп",
  success: "успіх",
  shutter: "затвор камери",
  scribble: "розчерк",
  flip: "перегортання",
  slide: "ковзання",
  cash: "каса",
  lock: "замок",
  zap: "розряд",
  snap: "клацання",
  bounce: "відскок",
  cheer: "оплески",
};

export const FACTS_FROM_BRANDKIT = "✓ підтверджено фактами бренд-кіта";

export const NOTE_UNVERIFIED =
  "Позначені твердження не знайдено на сайті. «Затвердити» означає, що ви їх підтверджуєте.";
export const ALL_VERIFIED = "✓ Усі цифри й обіцянки знайдено на сайті";

/**
 * Українська множина: 1 сцена, 2 сцени, 5 сцен, 21 сцена.
 * @param {number} n
 * @param {[string, string, string]} forms
 */
export function plural(n, [one, few, many]) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/**
 * Мета під концептом: «15,0 с · 30 кадр/с · 3 сцени».
 * @param {Pick<ScriptCheckpointPayload, "durationSeconds"> & { storyboard: { fps: number, scenes: readonly unknown[] } }} payload
 */
export function formatMeta(payload) {
  const n = payload.storyboard.scenes.length;
  return `${formatSeconds(payload.durationSeconds)} с · ${payload.storyboard.fps} кадр/с · ${n} ${plural(n, ["сцена", "сцени", "сцен"])}`;
}

/**
 * URL медіа, який можна віддати в `<img src>`: лише шляхи нашого сервера (`/files/…`, `/static/…`)
 * або абсолютні http(s). Інше (`javascript:`, `data:`, `//host`, відносні) — `null`.
 * @param {unknown} url
 * @returns {string | null}
 */
export function safeMediaUrl(url) {
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (/^\/(?:files|static)\//.test(u)) return u;
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Текст з підсвіченими фрагментами: текстові вузли + `<mark class="cs-mark">` (усі входження,
 * перекриття зливаються). Порожні фрагменти й ті, яких у тексті немає, пропускаються.
 * @param {string} value
 * @param {readonly string[]} fragments
 * @returns {Node[]}
 */
export function highlight(value, fragments) {
  const src = String(value ?? "");
  /** @type {[number, number][]} */
  const ranges = [];
  for (const f of fragments) {
    if (!f) continue;
    for (let at = src.indexOf(f); at !== -1; at = src.indexOf(f, at + f.length))
      ranges.push([at, at + f.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  /** @type {Node[]} */
  const out = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push(document.createTextNode(src.slice(pos, a)));
    out.push(h("mark", { class: "cs-mark", text: src.slice(a, b) }));
    pos = b;
  }
  if (pos < src.length || out.length === 0) out.push(document.createTextNode(src.slice(pos)));
  return out;
}

/**
 * «Факти» сцени: тексти підтверджених тверджень («✓ «75 грн», «-10%»»); без них, але з `factIds` —
 * загальна позначка; інакше «—». Сирі id фактів власнику не показуємо.
 * @param {Pick<Scene, "id" | "factIds">} scene
 * @param {readonly { sceneId: string, text: string }[]} verified
 */
export function factsLabel(scene, verified) {
  const texts = [...new Set(verified.filter((c) => c.sceneId === scene.id && c.text).map((c) => c.text))];
  if (texts.length > 0) return `✓ ${texts.map((t) => `«${t}»`).join(", ")}`;
  return scene.factIds.length > 0 ? FACTS_FROM_BRANDKIT : "—";
}

/**
 * Непорожній рядок або `null` (поля-примітки старих розкадровок відсутні чи порожні).
 * @param {unknown} v
 */
const note = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Чи можна зараз затвердити/правити: статус `awaiting_script` і відкритий чекпоінт.
 * @param {Pick<UiState, "status" | "checkpoints">} state
 */
export function isActive(state) {
  return state.status === CHECKPOINT_STATUS.script && state.checkpoints.script?.state === "open";
}

/** @param {number} i */
const num2 = (i) => String(i + 1).padStart(2, "0");

/**
 * Payload чекпоінта 2 зі стану або `null`.
 * @param {CheckpointEntry | null | undefined} entry
 * @returns {ScriptCheckpointPayload | null}
 */
function scriptPayloadOf(entry) {
  const p = entry?.payload;
  return p && p.checkpoint === "script" ? p : null;
}

/** @param {number} pct */
const pctCss = (pct) => `${Math.round(pct * 1000) / 1000}%`;

/**
 * Трек сцен + шкала секунд.
 * @param {ScriptCheckpointPayload} payload
 * @param {Timeline} timeline
 */
function track(payload, timeline) {
  const layout = trackLayout(timeline);
  const scenes = payload.storyboard.scenes;
  const tones = ["cs-block--t2", "cs-block--t3"];
  const blocks = layout.blocks.map((b) => {
    const scene = scenes[b.index];
    const purpose = scene ? (PURPOSE_LABELS[scene.purpose] ?? scene.purpose) : "";
    const secs = scene ? formatSeconds(scene.durationFrames / timeline.fps) : "";
    return h(
      "div",
      {
        class: `cs-block ${b.index === 0 ? "cs-block--ink" : tones[(b.index - 1) % 2]}`,
        "data-scene": b.id,
        title: `S${b.index + 1} · ${purpose} · ${secs} с`,
        style: { "--l": pctCss(b.leftPct), "--w": pctCss(b.widthPct) },
      },
      h("span", { class: "cs-block__num", text: num2(b.index) }),
      h("span", { class: "cs-block__purpose", text: purpose }),
    );
  });
  const transitions = layout.transitions.map((t) =>
    h("div", {
      class: "cs-transition",
      "data-from": scenes[t.fromIndex]?.id ?? "",
      "data-to": scenes[t.toIndex]?.id ?? "",
      "data-frames": t.frames,
      style: { "--l": pctCss(t.leftPct), "--w": pctCss(t.widthPct) },
    }),
  );

  const marks = secondMarks(timeline.durationSeconds);
  const lastMajor = marks.findLast((m) => m.major);
  const scale = h(
    "div",
    { class: "cs-scale", "aria-hidden": "true" },
    marks.map((m) => {
      const edge = m.pct <= 0 ? " cs-scale__mark--start" : m.pct >= 99.999 ? " cs-scale__mark--end" : "";
      return h(
        "span",
        {
          class: `cs-scale__mark${m.major ? " cs-scale__mark--major" : ""}${edge}`,
          "data-sec": m.seconds,
          style: { "--l": pctCss(m.pct) },
        },
        m.major ? h("span", { class: "cs-scale__label", text: `${m.seconds} с` }) : null,
      );
    }),
    // Кінець ролика, якщо до останньої підписаної позначки далеко (16,5 с при позначці 15).
    lastMajor && timeline.durationSeconds - lastMajor.seconds >= 2
      ? h(
          "span",
          { class: "cs-scale__mark cs-scale__mark--major cs-scale__mark--end", style: { "--l": "100%" } },
          h("span", { class: "cs-scale__label", text: `${formatSeconds(timeline.durationSeconds)} с` }),
        )
      : null,
  );

  const n = scenes.length;
  return h(
    "div",
    { class: "cs-track-wrap" },
    h(
      "div",
      {
        class: "cs-track",
        role: "img",
        "aria-label": `Трек: ${n} ${plural(n, ["сцена", "сцени", "сцен"])}, ${formatSeconds(timeline.durationSeconds)} с`,
      },
      blocks,
      transitions,
    ),
    scale,
  );
}

/**
 * Рядок «не підтверджено: «…»» (X3).
 * @param {Claim} claim
 */
function unverifiedLine(claim) {
  return h(
    "li",
    { class: "cs-unverified", "data-claim": claim.text },
    h("span", { class: "dot dot--accent", "aria-hidden": "true" }),
    `не підтверджено: «${claim.text}»`,
  );
}

/**
 * Пара «мітка — значення» в мета-сітці сцени.
 * @param {string} key
 * @param {string} label
 * @param {string} value
 * @param {string} [title]
 */
function metaItem(key, label, value, title) {
  return h(
    "div",
    { class: "cs-scene__meta-item", "data-meta": key },
    h("dt", { class: "label-s", text: label }),
    h("dd", { class: "mono", text: value, title }),
  );
}

/**
 * Рядок сцени.
 * @param {Scene} scene
 * @param {number} index
 * @param {number} fps
 * @param {Claim[]} claims непідтверджені твердження цієї сцени
 * @param {Claim[]} verified підтверджені твердження розкадровки
 * @param {{ assetId: string, url: string }[]} thumbs мініатюри асетів сцени
 */
function sceneRow(scene, index, fps, claims, verified, thumbs) {
  const purpose = PURPOSE_LABELS[scene.purpose] ?? scene.purpose;
  const of = /** @param {"headline" | "sub"} field */ (field) =>
    claims.filter((c) => c.field === field).map((c) => c.text);
  const motion = note(scene.motionNote);
  const sfx = scene.sfxCue ? SFX_LABELS[scene.sfxCue] : undefined;
  const transition =
    index === 0
      ? "—"
      : `${TRANSITION_LABELS[scene.transitionIn] ?? scene.transitionIn}${
          scene.transitionFrames > 0 ? ` · ${formatSeconds(scene.transitionFrames / fps)} с` : ""
        }`;

  return h(
    "li",
    { class: "spec-row cs-scene", "data-scene": scene.id },
    h(
      "div",
      { class: "cs-scene__label" },
      h("span", { class: "display-s cs-scene__num", text: num2(index) }),
      h("span", {
        class: "label-s cs-scene__purpose",
        "data-purpose": scene.purpose,
        text: `${purpose} · ${formatSeconds(scene.durationFrames / fps)} с`,
      }),
    ),
    h(
      "div",
      { class: "cs-scene__main" },
      h(
        "div",
        { class: "cs-scene__text" },
        h("p", { class: "scene-head cs-scene__head" }, highlight(scene.text.headline, of("headline"))),
        scene.text.sub ? h("p", { class: "cs-scene__sub" }, highlight(scene.text.sub, of("sub"))) : null,
        claims.length > 0 ? h("ul", { class: "cs-unverified-list" }, claims.map(unverifiedLine)) : null,
        h(
          "dl",
          { class: "cs-scene__meta" },
          motion ? metaItem("motion", "Рух", motion) : null,
          metaItem("facts", "Факти", factsLabel(scene, verified)),
          metaItem("transition", "Перехід", transition),
          sfx ? metaItem("sfx", "Звук", sfx) : null,
        ),
      ),
      thumbs.length > 0
        ? h(
            "div",
            { class: "cs-scene__thumbs" },
            thumbs.map((t) => thumb(t, scene)),
          )
        : null,
    ),
  );
}

/**
 * @param {{ assetId: string, url: string }} t
 * @param {Scene | null} scene
 */
function thumb(t, scene) {
  return h("img", {
    class: "cs-thumb",
    src: t.url,
    alt: scene ? `Фото сцени ${scene.id.toUpperCase()}` : "Фото",
    loading: "lazy",
    decoding: "async",
    "data-asset": t.assetId,
  });
}

/**
 * Весь вміст під шапкою для payload.
 * @param {ScriptCheckpointPayload} payload
 * @returns {(Node | null)[]} вузли по порядку; `null` — секції, яких для payload немає
 */
function content(payload) {
  const sb = payload.storyboard;
  const timeline = tryTimeline(sb);
  const unverified = payload.claims?.unverified ?? [];
  const verified = payload.claims?.verified ?? [];
  const sceneIds = new Set(sb.scenes.map((s) => s.id));
  const thumbs = (payload.thumbnails ?? [])
    .map((t) => ({ assetId: t.assetId, url: safeMediaUrl(t.url) }))
    .filter(/** @returns {t is { assetId: string, url: string }} */ (t) => t.url !== null);
  const usedAssets = new Set(sb.scenes.flatMap((s) => s.assetIds));
  const looseThumbs = thumbs.filter((t) => !usedAssets.has(t.assetId));
  const orphanClaims = unverified.filter((c) => !sceneIds.has(c.sceneId));

  const claims =
    unverified.length === 0
      ? h("p", { class: "cs-claims cs-claims--ok", text: ALL_VERIFIED })
      : h(
          "div",
          { class: "cs-claims cs-claims--warn" },
          orphanClaims.length > 0
            ? h("ul", { class: "cs-unverified-list" }, orphanClaims.map(unverifiedLine))
            : null,
          h("p", { class: "cs-note", text: NOTE_UNVERIFIED }),
        );

  const music = payload.musicBrief;
  const musicNote = note(sb.musicNote);
  return [
    h(
      "div",
      { class: "cs-intro" },
      h("h1", { class: "display-s cs-concept", text: sb.concept }),
      h("p", { class: "body-l cs-hook", text: `Хук: «${sb.hook}»` }),
      h("p", { class: "mono cs-meta", text: formatMeta(payload) }),
    ),
    timeline ? track(payload, timeline) : null,
    claims,
    h(
      "ol",
      { class: "cs-scenes", "aria-label": "Сцени" },
      sb.scenes.map((scene, i) =>
        sceneRow(
          scene,
          i,
          sb.fps,
          unverified.filter((c) => c.sceneId === scene.id),
          verified,
          thumbs.filter((t) => scene.assetIds.includes(t.assetId)),
        ),
      ),
    ),
    music
      ? h(
          "div",
          { class: "spec-row cs-music" },
          h("span", { class: "spec-row__label", text: "Музика" }),
          h(
            "div",
            { class: "cs-music__body" },
            h("p", { class: "body-l cs-music__note", text: musicNote ?? music.genre }),
            // Темп у musicNote уже названо словами; рядок BPM — лише для старих розкадровок (жанр).
            musicNote
              ? null
              : h(
                  "p",
                  { class: "mono cs-music__tech" },
                  h("span", { class: "cs-music__bpm", text: `${music.bpm} BPM` }),
                ),
          ),
        )
      : null,
    looseThumbs.length > 0
      ? h(
          "div",
          { class: "spec-row cs-photos" },
          h("span", { class: "spec-row__label", text: "Фото" }),
          h(
            "div",
            { class: "cs-photos__list" },
            looseThumbs.map((t) => thumb(t, null)),
          ),
        )
      : null,
  ];
}

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  let pending = false;
  let destroyed = false;

  const diamond = h("span", { class: "diamond", "aria-hidden": "true" });
  const eyebrow = h("span", { class: "cs-eyebrow__text" });
  const editBtn = h("button", {
    type: "button",
    class: "btn btn--ghost cs-edit",
    "data-action": "edit",
    text: "Правки",
  });
  const approveBtn = h(
    "button",
    { type: "button", class: "btn btn--primary cs-approve", "data-action": "approve" },
    "Затвердити",
    h("span", { class: "btn__arrow", "aria-hidden": "true", text: "→" }),
  );
  const body = h("div", { class: "cs-body" });
  const root = h(
    "section",
    { class: "cs adc-enter", "aria-label": "Чекпоінт 2 — тексти" },
    h(
      "header",
      { class: "cs-head" },
      h("div", { class: "eyebrow cs-eyebrow" }, diamond, eyebrow),
      h("div", { class: "cs-actions" }, editBtn, approveBtn),
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
      console.error("[cp-script] approve", err);
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
    const st = state.checkpoints.script?.state;
    diamond.classList.toggle("diamond--open", active);
    diamond.classList.toggle("diamond--ring", active);
    diamond.classList.toggle("diamond--done", st === "approved");
    diamond.classList.toggle("diamond--stale", st === "superseded");
    root.dataset.state = active ? "open" : (st ?? "none");
  }

  /** @param {UiState} state */
  function rebuild(state) {
    const entry = state.checkpoints.script;
    const payload = scriptPayloadOf(entry);
    text(eyebrow, `Чекпоінт 2 / 3 · Тексти${entry ? ` · ревізія ${entry.rev}` : ""}`);
    clear(body);
    if (payload) {
      for (const node of content(payload)) if (node) body.append(node);
    } else body.append(h("p", { class: "body-l cs-empty", text: "Сценарій ще не надійшов." }));
  }

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    const entry = state.checkpoints.script;
    const before = prev?.checkpoints.script;
    if (!prev || entry?.payload !== before?.payload || entry?.rev !== before?.rev) rebuild(state);
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
      root.remove();
    },
  };
}
