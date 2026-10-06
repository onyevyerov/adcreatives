import {
  computeTimeline,
  FORMATS,
  type Format,
  MAX_TOTAL_FRAMES,
  MIN_SCENE_FRAMES,
  MIN_TOTAL_FRAMES,
  SceneId,
  Storyboard,
} from "@adc/shared";

/**
 * `normalizeStoryboard` — доведення розкадровки від LLM кодом (без LLM):
 * - унікальні id сцен (s1, s2, …), перша сцена без переходу, `cut` ⇔ 0 кадрів переходу;
 * - неіснуючі assetIds/factIds викидаються, emphasis лише з фраз, що є в тексті;
 * - сцена ≥ 45 кадрів; перехід ≤ третини коротшої сусідньої сцени;
 * - загальна тривалість за `computeTimeline` у межах 450–900 кадрів (або рівно бажана тривалість
 *   клієнта) — пропорційним масштабуванням тривалостей сцен;
 * - довжина текстів звіряється з `copyRules` для обраних форматів → `textIssues` (текст не
 *   переписується: це робить стадія повторним викликом моделі або людина на чекпоінті 2).
 */

export const DEFAULT_TRANSITION_FRAMES = 12;
const MAX_CHARS_RANGE = [8, 60] as const;
const MAX_LINES_RANGE = [1, 4] as const;

export interface TextIssue {
  sceneId: string;
  field: "headline" | "sub";
  format: Format;
  /** `length` — весь текст довший за maxCharsPerLine × maxLines; `word` — слово довше за рядок. */
  kind: "length" | "word";
  actual: number;
  limit: number;
  text: string;
}

export interface NormalizeOptions {
  /** Відомі асети (assets.json / brand.assets); інші assetIds викидаються. */
  assetIds: Iterable<string>;
  /** Відомі факти; якщо не задано — factIds не фільтруються. */
  factIds?: Iterable<string>;
  /** Обрані формати для перевірки довжини тексту (дефолт — усі три). */
  formats?: readonly Format[];
  /** Бажана тривалість від клієнта, с; null — модель обирає в межах 15–30 с. */
  durationSeconds?: number | null;
}

export interface NormalizeResult {
  storyboard: Storyboard;
  /** Що змінено (для логів і трейсу). */
  changes: string[];
  textIssues: TextIssue[];
  totalFrames: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function totalOf(d: number[], t: number[]): number {
  return d.reduce((a, b) => a + b, 0) - t.reduce((a, b, i) => a + (i === 0 ? 0 : b), 0);
}

function clampTransitions(d: number[], t: number[]): void {
  t[0] = 0;
  for (let i = 1; i < d.length; i++) {
    const max = Math.floor(Math.min(d[i - 1] as number, d[i] as number) / 3);
    t[i] = clamp(t[i] as number, 0, max);
  }
}

/** Мінімальна тривалість сцени з урахуванням її переходів (перехід ≤ 1/3 сцени). */
function floorFor(i: number, t: number[]): number {
  return Math.max(MIN_SCENE_FRAMES, 3 * (t[i] ?? 0), 3 * (t[i + 1] ?? 0));
}

/** Доводить загальну тривалість до target, змінюючи тривалості сцен. */
function scaleTo(d: number[], t: number[], target: number): void {
  for (let iter = 0; iter < 8; iter++) {
    const total = totalOf(d, t);
    if (total === target) return;
    const sumT = t.reduce((a, b, i) => a + (i === 0 ? 0 : b), 0);
    const sumD = d.reduce((a, b) => a + b, 0);
    const k = (target + sumT) / sumD;
    for (let i = 0; i < d.length; i++) d[i] = Math.max(MIN_SCENE_FRAMES, Math.round((d[i] as number) * k));
    clampTransitions(d, t);
    let delta = target - totalOf(d, t);
    if (delta > 0) {
      const longest = d.indexOf(Math.max(...d));
      d[longest] = (d[longest] as number) + delta;
      delta = 0;
    } else if (delta < 0) {
      const order = d.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
      for (const [, i] of order) {
        const room = (d[i] as number) - floorFor(i, t);
        const take = Math.min(room, -delta);
        if (take > 0) {
          d[i] = (d[i] as number) - take;
          delta += take;
        }
        if (delta === 0) break;
      }
    }
    clampTransitions(d, t);
  }
}

function graphemeLength(s: string): number {
  return [...s].length;
}

/** Текстові ліміти сцени за copyRules для обраних форматів. */
export function checkCopy(storyboard: Storyboard, formats: readonly Format[] = FORMATS): TextIssue[] {
  const issues: TextIssue[] = [];
  const rules = storyboard.copyRules;
  for (const scene of storyboard.scenes) {
    for (const field of ["headline", "sub"] as const) {
      const text = scene.text[field];
      if (!text) continue;
      const lines = field === "headline" ? rules.maxLines.headline : rules.maxLines.sub;
      for (const format of formats) {
        const perLine = rules.maxCharsPerLine[format];
        const limit = perLine * lines;
        const actual = graphemeLength(text);
        if (actual > limit) {
          issues.push({ sceneId: scene.id, field, format, kind: "length", actual, limit, text });
        }
        const longest = Math.max(...text.split(/\s+/).map(graphemeLength));
        if (longest > perLine) {
          issues.push({
            sceneId: scene.id,
            field,
            format,
            kind: "word",
            actual: longest,
            limit: perLine,
            text,
          });
        }
      }
    }
  }
  return issues;
}

export function normalizeStoryboard(input: Storyboard, opts: NormalizeOptions): NormalizeResult {
  const sb: Storyboard = structuredClone(input);
  const changes: string[] = [];
  const assetSet = new Set(opts.assetIds);
  const factSet = opts.factIds ? new Set(opts.factIds) : null;

  // ---------- id сцен ----------
  const used = new Set<string>();
  const renamed = new Map<string, string>();
  let next = 1;
  for (const scene of sb.scenes) {
    if (SceneId.safeParse(scene.id).success && !used.has(scene.id)) {
      used.add(scene.id);
      continue;
    }
    while (used.has(`s${next}`)) next++;
    const id = `s${next}`;
    changes.push(`id сцени «${scene.id}» → ${id}`);
    renamed.set(scene.id, id);
    scene.id = id;
    used.add(id);
  }
  for (const part of sb.musicBrief.structure) {
    part.sceneIds = part.sceneIds.map((id) => renamed.get(id) ?? id).filter((id) => used.has(id));
  }

  // ---------- вміст сцен ----------
  for (const scene of sb.scenes) {
    const assets = [...new Set(scene.assetIds)].filter((id) => assetSet.has(id));
    if (assets.length !== scene.assetIds.length) {
      const dropped = scene.assetIds.filter((id) => !assetSet.has(id));
      if (dropped.length) changes.push(`${scene.id}: викинуто неіснуючі assetIds ${dropped.join(", ")}`);
    }
    scene.assetIds = assets;
    if (factSet) {
      const facts = [...new Set(scene.factIds)].filter((id) => factSet.has(id));
      if (facts.length !== scene.factIds.length) changes.push(`${scene.id}: викинуто неіснуючі factIds`);
      scene.factIds = facts;
    }
    scene.text.headline = scene.text.headline.trim();
    const sub = scene.text.sub?.trim() ?? null;
    scene.text.sub = sub ? sub : null;
    const haystack = `${scene.text.headline}\n${scene.text.sub ?? ""}`.toLowerCase();
    const emphasis = [...new Set(scene.text.emphasis.map((e) => e.trim()).filter(Boolean))].filter((e) =>
      haystack.includes(e.toLowerCase()),
    );
    if (emphasis.length !== scene.text.emphasis.length)
      changes.push(`${scene.id}: emphasis без збігу з текстом`);
    scene.text.emphasis = emphasis;
  }

  // ---------- copyRules ----------
  for (const f of FORMATS) {
    const v = clamp(Math.round(sb.copyRules.maxCharsPerLine[f]), ...MAX_CHARS_RANGE);
    if (v !== sb.copyRules.maxCharsPerLine[f]) changes.push(`copyRules.maxCharsPerLine.${f} → ${v}`);
    sb.copyRules.maxCharsPerLine[f] = v;
  }
  for (const k of ["headline", "sub"] as const) {
    const v = clamp(Math.round(sb.copyRules.maxLines[k]), ...MAX_LINES_RANGE);
    if (v !== sb.copyRules.maxLines[k]) changes.push(`copyRules.maxLines.${k} → ${v}`);
    sb.copyRules.maxLines[k] = v;
  }

  // ---------- переходи ----------
  sb.scenes.forEach((scene, i) => {
    if (i === 0) {
      if (scene.transitionFrames !== 0) changes.push(`${scene.id}: перша сцена без переходу`);
      scene.transitionFrames = 0;
      return;
    }
    if (scene.transitionIn === "cut" && scene.transitionFrames !== 0) {
      scene.transitionFrames = 0;
      changes.push(`${scene.id}: cut → 0 кадрів переходу`);
    } else if (scene.transitionIn !== "cut" && scene.transitionFrames === 0) {
      scene.transitionFrames = DEFAULT_TRANSITION_FRAMES;
      changes.push(`${scene.id}: ${scene.transitionIn} без тривалості → ${DEFAULT_TRANSITION_FRAMES} кадрів`);
    }
  });

  // ---------- таймінги ----------
  const d = sb.scenes.map((s) => Math.max(1, Math.round(s.durationFrames)));
  const t = sb.scenes.map((s) => Math.max(0, Math.round(s.transitionFrames)));
  const before = totalOf(d, t);
  for (let i = 0; i < d.length; i++) d[i] = Math.max(MIN_SCENE_FRAMES, d[i] as number);
  clampTransitions(d, t);

  let target: number | null = null;
  if (opts.durationSeconds != null) {
    target = clamp(Math.round(opts.durationSeconds * sb.fps), MIN_TOTAL_FRAMES, MAX_TOTAL_FRAMES);
  } else {
    const total = totalOf(d, t);
    if (total < MIN_TOTAL_FRAMES) target = MIN_TOTAL_FRAMES;
    else if (total > MAX_TOTAL_FRAMES) target = MAX_TOTAL_FRAMES;
  }
  if (target !== null) scaleTo(d, t, target);

  sb.scenes.forEach((scene, i) => {
    const nd = d[i] as number;
    const nt = t[i] as number;
    if (nd !== scene.durationFrames) changes.push(`${scene.id}: ${scene.durationFrames} → ${nd} кадрів`);
    if (nt !== scene.transitionFrames) changes.push(`${scene.id}: перехід ${scene.transitionFrames} → ${nt}`);
    scene.durationFrames = nd;
    scene.transitionFrames = nt;
    if (i > 0 && nt === 0 && scene.transitionIn !== "cut") scene.transitionIn = "cut";
  });

  const parsed = Storyboard.parse(sb);
  const timeline = computeTimeline(parsed);
  if (timeline.totalFrames !== before) changes.push(`тривалість ${before} → ${timeline.totalFrames} кадрів`);
  if (target !== null && timeline.totalFrames !== target) {
    changes.push(`не вдалося точно досягти ${target} кадрів (вийшло ${timeline.totalFrames})`);
  }

  return {
    storyboard: parsed,
    changes,
    textIssues: checkCopy(parsed, opts.formats ?? FORMATS),
    totalFrames: timeline.totalFrames,
  };
}
