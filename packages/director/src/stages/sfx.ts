import {
  applySfxPlan,
  CheckReport,
  computeTimeline,
  type Format,
  HIT_SOUND_CUES,
  type ImageInput,
  inputsHash,
  momentLegend,
  primaryFormat,
  type ReviewIssue,
  readTuning,
  revPaths,
  type SfxDecision,
  SfxPlan,
  SfxPlanDraft,
  SOUND_CUE_TRAITS,
  SoundCue,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  type Storyboard,
  sha256,
  type Tuning,
  t,
} from "@adc/shared";
import {
  baseRevOf,
  formatsOf,
  llmStageError,
  progress,
  readCurrentBrandKit,
  readOptional,
  readProject,
  readStoryboard,
  readTemplateScenes,
} from "../io.ts";
import { qaSceneImages, toQaJpeg } from "./qa.ts";

export const SFX_PROMPT = "sfx-design";

export interface SfxStageDeps {
  /** Перемикачі генерації; дефолт — `readTuning()` з env на кожен запуск стадії. */
  tuning?: () => Tuning;
}

/** Важких ударів (`HIT_SOUND_CUES`) на весь ролик — не більше. */
export const MAX_FILM_HITS = 3;
/** Сигнатурні cue: прийом, який від повтору перестає працювати (як у `prompts/storyboard.md`). */
export const SIGNATURE_SOUND_CUES: ReadonlySet<SoundCue> = new Set<SoundCue>([
  "cash",
  "cheer",
  "scratch",
  "glitch",
]);
/** Кожного сигнатурного cue на весь ролик — не більше. */
export const MAX_SIGNATURE_PER_CUE = 2;

/** Коли який cue: колонка «use it for» таблиці `<cues>` промпта (числа — з `SOUND_CUE_TRAITS`). */
const CUE_USE: Readonly<Record<SoundCue, string>> = {
  whoosh: "a big fast move: an object or the camera flying past, a scene-wide pass",
  swoosh: "a lighter pass: a card, a panel or a text block sweeping in or out",
  riser: "tension that builds into the hit right after it; never without that hit",
  impact: "a structural hit: the hook, the climax, the logo",
  slam: "something heavy landing or stamped, a hard stop",
  pop: "a small element appearing: a badge, a bubble, a list item; repeated pops climb in pitch",
  ding: "a positive confirmation: a check mark, a reached result; repeated dings climb in pitch",
  shimmer: "a shine or sparkle, a premium or magical reveal",
  tick: "one step of a fast count, a clock, a timer",
  click: "a button, a toggle or a cursor click",
  drop: "a deep bass drop on the climax or the finale",
  error: "a failure: a wrong value, a red cross, the problem shown",
  alert: "a warning: an urgent badge, something that needs attention",
  glitch: "a digital distortion, a broken screen, a switch of reality",
  scratch: "a record scratch: a sudden stop or twist",
  typing: "text typed character by character, a field filling in",
  notify: "an incoming notification or message bubble",
  scan: "a scan line, a search, a sweep over data",
  swipe: "a finger swipe on a phone, a card swiped aside",
  success: "a finished task, a payment accepted, the result delivered",
  shutter: "a photo or screenshot taken, a flash",
  scribble: "a pen stroke, a hand-drawn underline or circle drawing in",
  flip: "a card, a page or a digit flipping",
  slide: "a panel, a drawer or a slider moving along",
  cash: "money: a price, a payment, revenue going up",
  lock: "security: a lock closing, something saved or sealed",
  zap: "energy or speed: an instant action, electricity",
  snap: "an element snapping into place, a magnetic fit",
  bounce: "a playful springy landing or bounce",
  cheer: "a crowd cheering: a celebration, a win, social proof",
};

const ANCHOR_TEXT = { onset: "starts on it", peak: "peaks on it", end: "ends on it" } as const;

/** Таблиця 30 cue з traits і лімітами коду — для промпта (детермінована). */
export function cueTable(): string {
  const yes = (b: boolean) => (b ? "yes" : "");
  const rows = SoundCue.options.map((cue) => {
    const tr = SOUND_CUE_TRAITS[cue];
    return `| ${cue} | ${CUE_USE[cue]} | ${ANCHOR_TEXT[tr.anchor]} | ${yes(tr.grid)} | ${yes(tr.hit)} | ${yes(
      SIGNATURE_SOUND_CUES.has(cue),
    )} | ${tr.pitch === "none" ? "" : tr.pitch} | ${tr.stereo} | ${tr.levelDb} | ${yes(tr.perScene)} |`;
  });
  return [
    "| cue | use it for | relation to the event frame `at` | snapped to the half-beat grid | heavy hit | signature | pitch | stereo | level over the music, dB | one timbre per scene |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "Limits the code enforces on the whole film after your answer:",
    `- heavy hits (cues with "heavy hit" = yes): at most ${MAX_FILM_HITS} in the whole film;`,
    `- signature cues (cues with "signature" = yes): each one at most ${MAX_SIGNATURE_PER_CUE} times in the whole film;`,
    `- one timbre per scene: in one scene use only one of the cues with "one timbre per scene" = yes (repeated ones climb in pitch as one melody).`,
  ].join("\n");
}

/** Порушення ліміту: правило, події (сцена/подія) і текст для точкового ретраю моделі. */
export interface SfxViolation {
  rule: "hits" | "signature" | "per_scene";
  events: Array<{ sceneId: string; eventId: string; cue: SoundCue }>;
  message: string;
}

interface PlacedEvent {
  sceneId: string;
  eventId: string;
  cue: SoundCue | null;
  /** Глобальний кадр (порядок у ролику). */
  frame: number;
  /** Порядковий номер події в ролику — для стабільного порядку за рівних кадрів. */
  order: number;
}

function placedEvents(sb: Storyboard): PlacedEvent[] {
  const timeline = computeTimeline(sb);
  const out: PlacedEvent[] = [];
  sb.scenes.forEach((scene, i) => {
    const from = timeline.scenes[i]?.from ?? 0;
    for (const ev of scene.events) {
      out.push({
        sceneId: scene.id,
        eventId: ev.id,
        cue: ev.sound?.cue ?? null,
        frame: from + ev.at,
        order: out.length,
      });
    }
  });
  return out.sort((a, b) => a.frame - b.frame || a.order - b.order);
}

const ref = (p: PlacedEvent) => `${p.sceneId}/${p.eventId} (${p.cue})`;
const asEvents = (list: PlacedEvent[]) =>
  list.map((p) => ({ sceneId: p.sceneId, eventId: p.eventId, cue: p.cue as SoundCue }));

/**
 * Порушення лімітів на ефективній розкадровці (після накладання плану): важкі удари > `MAX_FILM_HITS` на
 * ролик, сигнатурний cue > `MAX_SIGNATURE_PER_CUE` на ролик, у сцені більше одного cue з `perScene`.
 * Детерміновано, у порядку ролику.
 */
export function sfxViolations(sb: Storyboard): SfxViolation[] {
  const all = placedEvents(sb);
  const out: SfxViolation[] = [];
  const hits = all.filter((p) => p.cue !== null && HIT_SOUND_CUES.has(p.cue));
  if (hits.length > MAX_FILM_HITS) {
    out.push({
      rule: "hits",
      events: asEvents(hits),
      message: `heavy hits: ${hits.length} in the film, the limit is ${MAX_FILM_HITS}: ${hits.map(ref).join(", ")}`,
    });
  }
  for (const cue of SIGNATURE_SOUND_CUES) {
    const uses = all.filter((p) => p.cue === cue);
    if (uses.length > MAX_SIGNATURE_PER_CUE) {
      out.push({
        rule: "signature",
        events: asEvents(uses),
        message: `signature cue ${cue}: ${uses.length} times in the film, the limit is ${MAX_SIGNATURE_PER_CUE}: ${uses.map(ref).join(", ")}`,
      });
    }
  }
  for (const scene of sb.scenes) {
    const own = all.filter(
      (p) => p.sceneId === scene.id && p.cue !== null && SOUND_CUE_TRAITS[p.cue].perScene,
    );
    const cues = [...new Set(own.map((p) => p.cue))];
    if (cues.length > 1) {
      out.push({
        rule: "per_scene",
        events: asEvents(own),
        message: `scene ${scene.id} mixes the one-timbre cues ${cues.join(" and ")}: ${own.map(ref).join(", ")}; use one of them in this scene`,
      });
    }
  }
  return out;
}

const keyOf = (sceneId: string, eventId: string) => `${sceneId}\u0000${eventId}`;

/**
 * Детерміноване обрізання за лімітами: зайві звуки вимикаються від кінця ролика, лише на подіях сцен зі
 * `scope` (решту план не рахує). Для `perScene` у сцені лишається cue першої такої події, інші мовчать.
 * Повертає нові рішення (вхід не мутується) і список вимкнених подій.
 */
export function trimToLimits(
  storyboard: Storyboard,
  decisions: readonly SfxDecision[],
  scope: readonly string[],
): {
  decisions: SfxDecision[];
  muted: Array<{ sceneId: string; eventId: string; rule: SfxViolation["rule"] }>;
} {
  const byKey = new Map<string, SfxDecision>();
  for (const d of decisions) byKey.set(keyOf(d.sceneId, d.eventId), d);
  const muted: Array<{ sceneId: string; eventId: string; rule: SfxViolation["rule"] }> = [];
  const mute = (p: PlacedEvent, rule: SfxViolation["rule"], why: string) => {
    byKey.set(keyOf(p.sceneId, p.eventId), {
      sceneId: p.sceneId,
      eventId: p.eventId,
      sound: null,
      reason: why,
    });
    p.cue = null;
    muted.push({ sceneId: p.sceneId, eventId: p.eventId, rule });
  };
  const all = placedEvents(applySfxPlan(storyboard, { decisions: [...byKey.values()] }).storyboard);
  const inScope = (p: PlacedEvent) => scope.includes(p.sceneId);

  // Один тембр у сцені: перший cue з perScene лишається, інші вимикаються.
  for (const sceneId of scope) {
    const own = all.filter(
      (p) => p.sceneId === sceneId && p.cue !== null && SOUND_CUE_TRAITS[p.cue].perScene,
    );
    const first = own[0]?.cue;
    for (const p of [...own].reverse()) {
      if (p.cue !== first) mute(p, "per_scene", `Muted by code: scene keeps one timbre (${first}).`);
    }
  }
  const capFromEnd = (
    pick: (p: PlacedEvent) => boolean,
    limit: number,
    rule: SfxViolation["rule"],
    why: string,
  ) => {
    const uses = all.filter((p) => p.cue !== null && pick(p));
    let excess = uses.length - limit;
    for (const p of [...uses].reverse()) {
      if (excess <= 0) break;
      if (!inScope(p)) continue;
      mute(p, rule, why);
      excess -= 1;
    }
  };
  capFromEnd(
    (p) => p.cue !== null && HIT_SOUND_CUES.has(p.cue),
    MAX_FILM_HITS,
    "hits",
    `Muted by code: over the limit of ${MAX_FILM_HITS} heavy hits in the film.`,
  );
  for (const cue of SIGNATURE_SOUND_CUES) {
    capFromEnd(
      (p) => p.cue === cue,
      MAX_SIGNATURE_PER_CUE,
      "signature",
      `Muted by code: ${cue} over the limit of ${MAX_SIGNATURE_PER_CUE} in the film.`,
    );
  }
  return { decisions: orderDecisions(storyboard, [...byKey.values()]), muted };
}

/** Рішення в порядку сцен і подій розкадровки (детерміновано); останнє для пари перемагає. */
function orderDecisions(sb: Storyboard, decisions: readonly SfxDecision[]): SfxDecision[] {
  const byKey = new Map<string, SfxDecision>();
  for (const d of decisions) byKey.set(keyOf(d.sceneId, d.eventId), d);
  const out: SfxDecision[] = [];
  for (const scene of sb.scenes) {
    for (const ev of scene.events) {
      const d = byKey.get(keyOf(scene.id, ev.id));
      if (d) out.push(d);
    }
  }
  return out;
}

/**
 * Рішення моделі → лише події сцен зі scope, що існують у розкадровці; решта — у `dropped`.
 */
function sanitize(
  sb: Storyboard,
  decisions: readonly SfxDecision[],
  scope: readonly string[],
): { kept: SfxDecision[]; dropped: SfxDecision[] } {
  const known = new Set(sb.scenes.flatMap((s) => s.events.map((e) => keyOf(s.id, e.id))));
  const kept: SfxDecision[] = [];
  const dropped: SfxDecision[] = [];
  for (const d of decisions) {
    if (scope.includes(d.sceneId) && known.has(keyOf(d.sceneId, d.eventId))) kept.push(d);
    else dropped.push(d);
  }
  return { kept: orderDecisions(sb, kept), dropped };
}

type Sound = Storyboard["scenes"][number]["events"][number]["sound"];
const sameSound = (a: Sound, b: Sound) =>
  a === null || b === null ? a === b : a.cue === b.cue && a.accent === b.accent;

/** Скільки рішень відрізняються від чернетки режисера і скільки озвучених подій замовкли. */
export function planStats(
  sb: Storyboard,
  decisions: readonly SfxDecision[],
): { changed: number; muted: number } {
  const draft = new Map<string, Sound>();
  for (const s of sb.scenes) for (const e of s.events) draft.set(keyOf(s.id, e.id), e.sound);
  let changed = 0;
  let muted = 0;
  for (const d of decisions) {
    const was = draft.get(keyOf(d.sceneId, d.eventId));
    if (was === undefined) continue;
    if (!sameSound(was, d.sound)) changed += 1;
    if (d.sound === null && was !== null) muted += 1;
  }
  return { changed, muted };
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/** Розкадровка для звукорежисера: сцени з часом у ролику, задумом, текстами й подіями з чернетковим звуком. */
export function sfxStoryboard(sb: Storyboard, scope: readonly string[], templates: ReadonlySet<string>) {
  const { fps } = sb;
  const timeline = computeTimeline(sb);
  const mixOf = (id: string) => sb.musicBrief.structure.find((p) => p.sceneIds.includes(id))?.mix ?? null;
  return {
    concept: sb.concept,
    hook: sb.hook,
    fps,
    throughline: sb.throughline?.object ?? null,
    scenes: sb.scenes.map((s, i) => {
      const from = timeline.scenes[i]?.from ?? 0;
      return {
        id: s.id,
        decide: scope.includes(s.id),
        template: templates.has(s.id),
        purpose: s.purpose,
        startSec: round(from / fps, 2),
        durationFrames: s.durationFrames,
        durationSec: round(s.durationFrames / fps, 2),
        musicMix: mixOf(s.id),
        motionIntent: s.motionIntent,
        transitionIn: s.transitionIn,
        items: s.items.map((it) => ({ id: it.id, role: it.role, text: it.text })),
        events: s.events.map((e) => ({
          id: e.id,
          at: e.at,
          atSec: round(e.at / fps, 2),
          filmSec: round((from + e.at) / fps, 2),
          what: e.what,
          draftSound: e.sound ? { cue: e.sound.cue, accent: e.sound.accent } : null,
          textIds: e.textIds,
        })),
      };
    }),
  };
}

const withoutSound = (sb: Storyboard) => ({
  ...sb,
  scenes: sb.scenes.map((s) => ({ ...s, events: s.events.map(({ sound: _sound, ...e }) => e) })),
});

interface SfxImage {
  sceneId: string;
  kind: "strip" | "stills" | "moments";
  image: ImageInput;
  hash: string;
  legend: string;
}

/** Стрічка (або запасні кадри) і аркуш моментів кожної сцени зі scope в одному форматі. */
async function sfxImages(
  storage: Storage,
  check: CheckReport,
  scope: readonly string[],
  format: Format,
  sb: Storyboard,
  rp: ReturnType<typeof revPaths>,
): Promise<SfxImage[]> {
  const strips = await qaSceneImages(storage, check, scope, [format], sb, rp);
  const out: SfxImage[] = [];
  for (const sceneId of scope) {
    const strip = strips.find((s) => s.sceneId === sceneId);
    if (!strip) continue;
    out.push({ sceneId, kind: strip.kind, image: strip.image, hash: strip.hash, legend: strip.legend });
    const index = sb.scenes.findIndex((s) => s.id === sceneId);
    const scene = sb.scenes[index];
    const sheet = check.moments.find((m) => m.sceneId === sceneId && m.format === format);
    if (!scene || scene.events.length === 0 || !sheet || !(await storage.exists(sheet.path))) continue;
    const data = await storage.read(sheet.path);
    out.push({
      sceneId,
      kind: "moments",
      image: await toQaJpeg(data),
      hash: sha256(data),
      legend: momentLegend(scene, format, sb.fps, index < sb.scenes.length - 1),
    });
  }
  return out;
}

function imagesLegend(images: readonly SfxImage[], scope: readonly string[], sb: Storyboard): string {
  const lines = images.map((img, i) => `Image ${i + 1}: ${img.legend.replaceAll("\n", "\n  ")}`);
  for (const id of scope) {
    const hasEvents = (sb.scenes.find((s) => s.id === id)?.events.length ?? 0) > 0;
    if (hasEvents && !images.some((img) => img.sceneId === id && img.kind === "moments")) {
      lines.push(`Scene ${id}: no moment sheet, judge its events from the strip alone.`);
    }
  }
  return lines.join("\n") || "(no images)";
}

function instructionsText(instructions: readonly ReviewIssue[], scope: readonly string[]): string {
  const own = instructions.filter((i) => i.sceneId === null || scope.includes(i.sceneId));
  if (own.length === 0) return "(none)";
  return own
    .map((i) => {
      const where = [
        i.sceneId ?? "film",
        i.eventId ? `event ${i.eventId}` : null,
        i.frame !== null ? `frame ${i.frame}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `- [${i.kind}, ${i.severity}] ${where}: ${i.description} → ${i.fix}`;
    })
    .join("\n");
}

function retryText(draft: SfxPlanDraft, violations: readonly SfxViolation[]): string {
  return [
    "<previous_answer>",
    JSON.stringify(draft, null, 2),
    "</previous_answer>",
    "",
    "The code checked this plan against the limits under <cues> and found:",
    ...violations.map((v) => `- ${v.message}`),
    "",
    "Answer again with the whole plan for the scenes to decide. Keep every other decision as it was; change only what these violations need, choosing which sounds to give up by what the frames show.",
  ].join("\n");
}

/**
 * Стадія `sfx` (звукорежисер): стрічки й аркуші моментів сцен зі scope у головному форматі + розкадровка з
 * чернетковим звуком → рішення cue/акцент/мовчання для кожної існуючої події → `rev/<n>/sfx-plan.json`.
 * Код після моделі: невідомі події відкидаються, ліміти (`sfxViolations`) — один точковий ретрай, далі
 * `trimToLimits`. Сцени поза scope — з попереднього плану цієї ревізії або ревізії-основи. Пропуск за хешем
 * входів (розкадровка без звуку, зображення, instructions, scope, промпт; модель — якщо задана `sfxModel`).
 * Модель — `Tuning.sfxModel` (null → frontmatter). userCached без `cache_control`: префікс (кадри й
 * розкадровка) читав би лише ретрай за лімітами, а він рідкісний — запис 5m-кешу був би марним.
 */
export function createSfxStage(deps: SfxStageDeps = {}): Stage<"sfx"> {
  const getTuning = deps.tuning ?? (() => readTuning());
  return async (ctx: StageContext<"sfx">) => {
    const { storage, projectId, rev, logger } = ctx;
    const { sfxModel } = getTuning();
    const rp = revPaths(projectId, rev);
    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const storyboard = await readStoryboard(storage, projectId, rev);
    const format = primaryFormat(formatsOf(project));
    const templates = new Set(await readTemplateScenes(storage, projectId, rev));
    const check = await readOptional(storage, rp.check, (v) => CheckReport.parse(v), logger);
    if (!check) {
      throw new StageError(
        `sfx: немає ${rp.check}`,
        "check_missing",
        "Спершу потрібна перевірка кадрів.",
        false,
      );
    }
    const allIds = storyboard.scenes.map((s) => s.id);
    const requested = (ctx.params.sceneIds ?? allIds).filter(
      (id) => allIds.includes(id) && !templates.has(id),
    );
    const parsePlan = (v: unknown) => SfxPlan.parse(v);
    const base = baseRevOf(project, rev);
    const basePlan =
      base !== null
        ? await readOptional(storage, revPaths(projectId, base).sfxPlan, parsePlan, logger)
        : null;
    // Попередній план: цієї ревізії (коло рецензії), а в новій ревізії — ревізії-основи.
    const ownPlan = await readOptional(storage, rp.sfxPlan, parsePlan, logger);
    const previous = ownPlan ?? basePlan;

    await progress(ctx, "sfx", t("sfxProgress"));
    const images = await sfxImages(storage, check, requested, format, storyboard, rp);
    // Сцени без жодного кадру (помилка рендера) — поза scope: звук наосліп не ставимо.
    const scope = requested.filter((id) => images.some((img) => img.sceneId === id));
    if (scope.length < requested.length) {
      logger.warn("sfx: сцени без кадрів лишаються з попереднім звуком", {
        scenes: requested.filter((id) => !scope.includes(id)),
      });
    }
    if (requested.length > 0 && scope.length === 0) {
      throw new StageError(
        "sfx: немає кадрів сцен",
        "sheets_missing",
        "Немає кадрів для звукорежисера.",
        false,
      );
    }

    const vars = {
      language: project?.language ?? brandFile.identity.language,
      format,
      scope: scope.join(", ") || "(none)",
      sheetsLegend: imagesLegend(images, scope, storyboard),
      storyboard: sfxStoryboard(storyboard, scope, templates),
      musicBrief: storyboard.musicBrief,
      musicHints: brandFile.visualStyle.musicHints,
      voice: brandFile.voice,
      cues: cueTable(),
      instructions: instructionsText(ctx.params.instructions, scope),
      previousPlan: previousFor(previous, scope),
    };
    const promptHash = ctx.prompts.load(SFX_PROMPT, vars).hash;
    const hash = inputsHash({
      storyboard: withoutSound(storyboard),
      images: images.map((img) => [img.sceneId, img.kind, img.hash]),
      instructions: ctx.params.instructions,
      scope,
      format,
      brand: { musicHints: vars.musicHints, voice: vars.voice, language: vars.language },
      prompt: promptHash,
      // Лише задана модель: з дефолтом хеш як раніше, а план іншої моделі не перевикористовується.
      ...(sfxModel !== null ? { model: sfxModel } : {}),
    });

    // Пропуск за хешем: план цієї ревізії або ревізії-основи з тими самими входами.
    for (const plan of [ownPlan, basePlan]) {
      if (plan?.inputsHash !== hash) continue;
      if (plan !== ownPlan) await storage.writeJson(rp.sfxPlan, plan);
      return {
        artifacts: [rp.sfxPlan],
        outputs: { sceneIds: plan.sceneIds, ...planStats(storyboard, plan.decisions) },
        reused: true,
        inputsHash: hash,
      };
    }

    const known = new Set(storyboard.scenes.flatMap((s) => s.events.map((e) => keyOf(s.id, e.id))));
    const kept = (previous?.decisions ?? []).filter(
      (d) => !scope.includes(d.sceneId) && known.has(keyOf(d.sceneId, d.eventId)),
    );
    const merge = (fresh: readonly SfxDecision[]) => orderDecisions(storyboard, [...kept, ...fresh]);
    const violationsOf = (decisions: readonly SfxDecision[]) =>
      sfxViolations(applySfxPlan(storyboard, { decisions: [...decisions] }).storyboard).filter((v) =>
        v.events.some((e) => scope.includes(e.sceneId)),
      );

    let decisions = merge([]);
    let notes = previous?.notes ?? "";
    if (scope.length > 0) {
      const call = (userText?: string) =>
        ctx.llm.structured(SFX_PROMPT, vars, SfxPlanDraft, {
          images: images.map((img) => img.image),
          cacheUserPrefix: false,
          ...(sfxModel !== null ? { model: sfxModel } : {}),
          ...(userText ? { userText, costDetail: "limits-retry" } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      const accept = (draft: SfxPlanDraft) => {
        const { kept: fresh, dropped } = sanitize(storyboard, draft.decisions, scope);
        if (dropped.length > 0) {
          logger.warn("sfx: відкинуто рішення для невідомих подій або сцен поза scope", {
            dropped: dropped.map((d) => `${d.sceneId}/${d.eventId}`),
          });
        }
        return merge(fresh);
      };
      let draft: SfxPlanDraft;
      try {
        draft = (await call()).data;
      } catch (err) {
        return llmStageError(err, "звукові ефекти");
      }
      decisions = accept(draft);
      notes = draft.notes;
      const violations = violationsOf(decisions);
      if (violations.length > 0) {
        logger.info("sfx: порушення лімітів — точковий ретрай", {
          violations: violations.map((v) => v.message),
        });
        try {
          const second = (await call(retryText(draft, violations))).data;
          decisions = accept(second);
          notes = second.notes || notes;
        } catch (err) {
          logger.warn("sfx: ретрай не вдався, обрізаю першу відповідь", { err: String(err) });
        }
      }
    }
    if (violationsOf(decisions).length > 0) {
      const trimmed = trimToLimits(storyboard, decisions, scope);
      decisions = trimmed.decisions;
      logger.warn("sfx: зайві звуки вимкнено за лімітами", {
        muted: trimmed.muted.map((m) => `${m.sceneId}/${m.eventId} (${m.rule})`),
      });
    }

    const plan = SfxPlan.parse({ version: 1, inputsHash: hash, sceneIds: scope, decisions, notes });
    await storage.writeJson(rp.sfxPlan, plan);
    return {
      artifacts: [rp.sfxPlan],
      outputs: { sceneIds: scope, ...planStats(storyboard, plan.decisions) },
      inputsHash: hash,
    };
  };
}

/** Рішення попереднього плану для сцен зі scope — щоб модель міняла точково. */
function previousFor(plan: SfxPlan | null, scope: readonly string[]): unknown {
  const own = (plan?.decisions ?? []).filter((d) => scope.includes(d.sceneId));
  return own.length > 0 ? { decisions: own, notes: plan?.notes ?? "" } : "(none)";
}

export const sfxStage: Stage<"sfx"> = createSfxStage();
