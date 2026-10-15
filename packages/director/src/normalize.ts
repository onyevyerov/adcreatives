import {
  beatFrames,
  computeTimeline,
  FORMATS,
  type Format,
  GRID_SOUND_CUES,
  HIT_SOUND_CUES,
  LEGACY_ARRIVE_EVENT_ID,
  MAX_TOTAL_FRAMES,
  MIN_SCENE_FRAMES,
  MIN_TOTAL_FRAMES,
  type Scene,
  SceneId,
  SoundCue,
  type SoundCue as SoundCueT,
  Storyboard,
  snapBpm,
} from "@adc/shared";

/**
 * `normalizeStoryboard` — доведення розкадровки від LLM кодом (без LLM):
 * - унікальні id сцен (s1, s2, …), перша сцена без переходу, `cut` ⇔ 0 кадрів переходу;
 * - неіснуючі assetIds/factIds викидаються, emphasis лише з фраз, що є в тексті;
 * - сцена ≥ 45 кадрів; перехід ≤ третини коротшої сусідньої сцени;
 * - загальна тривалість за `computeTimeline` у межах 450–900 кадрів (або рівно бажана тривалість
 *   клієнта) — пропорційним масштабуванням тривалостей сцен;
 * - `musicBrief.bpm` → найближчий з `BPM_GRID`; початки сцен (`from` на таймлайні, тобто склейки й
 *   межі частин зведення) — на тактах (`quantizeScenes`), якщо жодна сцена не змінюється більше ніж
 *   на пів такту, інакше — на долях; загальна тривалість та сама (остачу забирає остання сцена);
 * - `musicBrief.structure`: перша (хук) і остання (фінал) сцени — у частині з `mix: "full"`
 *   (`enforceMusicEnds`): ролик відкривається повним треком і не закінчується провалом;
 * - `items`: trim, унікальні id, відомі factIds; `events`: унікальні id, `at` у межах сцени
 *   (пропорційно до зміни тривалості; riser — до першого кадру наступної сцени), cue з `GRID_SOUND_CUES` —
 *   на найближчу восьму, riser ближче пів долі до наступної озвученої події — рівно на неї; legacy `sfxCue` →
 *   подія "arrive";
 * - щільність важких ударів (`limitHits`, `HIT_SOUND_CUES`): ≤ `1 + floor(totalSec / 6)` на ролик і ≤ 1
 *   у вікні 3 с, зайві → `pop`; riser далі ніж за 2 такти до події — попередження;
 * - довжина текстів звіряється з `copyRules` для обраних форматів → `textIssues` (текст не
 *   переписується: це робить стадія повторним викликом моделі або людина на чекпоінті 2);
 * - `throughline` (`normalizeThroughline`): стани невідомих сцен викидаються, відсутні сцени дописуються
 *   станом "carried over unchanged", порядок — за сценами; null лишається null; на таймінги не впливає.
 */

export const DEFAULT_TRANSITION_FRAMES = 12;
const MAX_CHARS_RANGE = [8, 60] as const;
const MAX_LINES_RANGE = [1, 4] as const;

export interface TextIssue {
  sceneId: string;
  /** `item` — текст з `scene.items` (перевіряється лише довжина слова). */
  field: "headline" | "sub" | "item";
  /** id з `scene.items`, коли `field === "item"`. */
  itemId?: string;
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
        const longest = longestWord(text);
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
    // Пункти не мають ліміту довжини (розкладку обирає автор фільму), але слово довше за рядок не переноситься.
    for (const item of scene.items) {
      const longest = longestWord(item.text, true);
      for (const format of formats) {
        const perLine = rules.maxCharsPerLine[format];
        if (longest > perLine) {
          issues.push({
            sceneId: scene.id,
            field: "item",
            itemId: item.id,
            format,
            kind: "word",
            actual: longest,
            limit: perLine,
            text: item.text,
          });
        }
      }
    }
  }
  return issues;
}

/** Адреси сайтів і пошти не скорочуються — їх не рахуємо як «довге слово» пункту. */
const UNBREAKABLE = /[@/]|\.\p{L}{2,}$/u;

function longestWord(text: string, skipUnbreakable = false): number {
  const words = text.split(/\s+/).filter((w) => !(skipUnbreakable && UNBREAKABLE.test(w)));
  return words.length ? Math.max(...words.map(graphemeLength)) : 0;
}

/** Долей у такті (4/4): трек генерується фразами по 4 такти, межі частин мають лягати на такти. */
const BEATS_PER_BAR = 4;
/**
 * Вага скорочення сцени проти подовження: коротша сцена стискає свої події й час на читання текстів.
 * Сцена breakdown (затримка подиху перед фіналом) і так коротка й тиха — її скорочення важить 1.
 */
const SHRINK_WEIGHT = 2;

/**
 * Початки сцен на сітці `grid` кадрів (динамічне програмування): склейка сцени i — `from` на таймлайні
 * (`computeTimeline`), кратний `grid`; остання сцена тягнеться до `total`. Мінімізує сумарну відносну
 * зміну довжин сцен (а не положень склейок — так довга сцена лишається довгою, коротка — короткою),
 * скорочення сцени i важить `shrinkWeight[i]`; кожна сцена ≥ свого мінімуму і змінюється не більше
 * ніж на `maxDelta` кадрів.
 * Повертає `durationFrames` сцен або null, якщо таких меж немає.
 */
function quantizeScenes(
  d: readonly number[],
  t: readonly number[],
  grid: number,
  total: number,
  maxDelta: number,
  shrinkWeight: readonly number[],
): number[] | null {
  const n = d.length;
  const tIn = (i: number) => (i === 0 || i >= n ? 0 : (t[i] as number));
  // Довжина сцени на таймлайні — від її `from` до `from` наступної (перехід наступної перекриває кінець).
  const raw = d.map((v, i) => v - tIn(i + 1));
  const minLen = d.map((_, i) => floorFor(i, t as number[]) - tIn(i + 1));
  const cost = (i: number, len: number): number => {
    const r = raw[i] as number;
    if (len < (minLen[i] as number) || Math.abs(len - r) > maxDelta) return Number.POSITIVE_INFINITY;
    return ((len - r) / Math.max(1, r)) ** 2 * (len < r ? (shrinkWeight[i] as number) : 1);
  };
  const kMax = Math.ceil(total / grid) - 1; // склейка строго до кінця ролика
  // best[k] — найменша вартість сцен 0..i, коли наступна сцена починається на k × grid.
  let best: number[] = [0];
  const choice: number[][] = [];
  for (let i = 0; i < n - 1; i++) {
    const next = new Array<number>(kMax + 1).fill(Number.POSITIVE_INFINITY);
    const from = new Array<number>(kMax + 1).fill(-1);
    for (let k0 = 0; k0 < best.length; k0++) {
      const c0 = best[k0] as number;
      if (!Number.isFinite(c0)) continue;
      for (let k = k0 + 1; k <= kMax; k++) {
        const c = c0 + cost(i, (k - k0) * grid);
        if (c < (next[k] as number)) {
          next[k] = c;
          from[k] = k0;
        }
      }
    }
    best = next;
    choice.push(from);
  }
  let end = -1;
  let endCost = Number.POSITIVE_INFINITY;
  for (let k = 0; k < best.length; k++) {
    const c = (best[k] as number) + cost(n - 1, total - k * grid);
    if (c < endCost) {
      endCost = c;
      end = k;
    }
  }
  if (end < 0) return null;
  const starts: number[] = [end];
  for (let i = n - 2; i >= 0; i--) starts.unshift((choice[i] as number[])[starts[0] as number] as number);
  // starts[i] — початок сцени i у кроках сітки (starts[0] = 0).
  return d.map((_, i) =>
    i === n - 1
      ? total - (starts[i] as number) * grid
      : ((starts[i + 1] as number) - (starts[i] as number)) * grid + tIn(i + 1),
  );
}

/**
 * Запасний шлях, коли мінімуми сцен не вміщаються в `total`: тривалості — цілі долі, остача — останній
 * сцені (вона не коротша за свій мінімум, навіть якщо ролик стає довшим).
 */
function quantizeToBeats(d: number[], t: number[], beat: number, total: number): void {
  const n = d.length;
  const need = total + t.reduce((a, b, i) => a + (i === 0 ? 0 : b), 0); // сума durationFrames
  const floorQ = (i: number) => Math.ceil(floorFor(i, t) / beat) * beat;
  // Межі округлюються накопичено, тож похибка не накопичується від сцени до сцени.
  let acc = 0;
  let placed = 0;
  for (let i = 0; i < n - 1; i++) {
    acc += d[i] as number;
    const end = Math.max(placed + floorQ(i), Math.round(acc / beat) * beat);
    d[i] = end - placed;
    placed = end;
  }
  let last = need - placed;
  const lastFloor = floorFor(n - 1, t);
  // Остачі замало для останньої сцени — забираємо по долі з найдовших попередніх.
  while (last < lastFloor) {
    let best = -1;
    for (let i = 0; i < n - 1; i++) {
      if ((d[i] as number) - beat >= floorQ(i) && (best < 0 || (d[i] as number) > (d[best] as number)))
        best = i;
    }
    if (best < 0) break;
    d[best] = (d[best] as number) - beat;
    last += beat;
  }
  d[n - 1] = Math.max(last, lastFloor);
}

/** `items`: trim, без порожніх, унікальні id (t1, t2, …), лише відомі factIds, порожня група → null. */
function normalizeItems(scene: Scene, factSet: Set<string> | null, changes: string[]): void {
  const raw = scene.items ?? [];
  const taken = new Set(raw.map((i) => i.id));
  const used = new Set<string>();
  const out: Scene["items"] = [];
  for (const item of raw) {
    const text = item.text.trim();
    if (!text) {
      changes.push(`${scene.id}: порожній пункт ${item.id} викинуто`);
      continue;
    }
    let id = item.id;
    if (used.has(id)) {
      let n = 1;
      while (taken.has(`t${n}`) || used.has(`t${n}`)) n++;
      id = `t${n}`;
      taken.add(id);
      changes.push(`${scene.id}: id пункту «${item.id}» → ${id}`);
    }
    used.add(id);
    const ids = item.factIds ?? [];
    const factIds = [...new Set(ids)].filter((f) => !factSet || factSet.has(f));
    if (factIds.length !== ids.length) changes.push(`${scene.id}: ${id} — викинуто неіснуючі factIds`);
    const group = item.group?.trim() || null;
    out.push({ ...item, id, text, group, factIds });
  }
  scene.items = out;
}

/** Стан наскрізного об'єкта для сцени, якої модель не описала: об'єкт переходить без змін. */
export const THROUGHLINE_CARRIED_OVER = "carried over unchanged";

/**
 * `throughline`: стани лише наявних сцен (перейменовані id — за новими), по одному на сцену, у порядку
 * сцен; сцена без стану отримує `THROUGHLINE_CARRIED_OVER`. null лишається null; порожній `object` → null.
 * На таймінги не впливає. Після нормалізації id сцен.
 */
function normalizeThroughline(sb: Storyboard, rename: (id: string) => string, changes: string[]): void {
  const tl = sb.throughline;
  if (!tl) {
    sb.throughline = null;
    return;
  }
  const object = tl.object.trim();
  if (!object) {
    changes.push("throughline: порожній object — наскрізний об'єкт прибрано");
    sb.throughline = null;
    return;
  }
  const sceneIds = new Set(sb.scenes.map((s) => s.id));
  const byScene = new Map<string, string>();
  for (const st of tl.states ?? []) {
    const id = rename(st.sceneId);
    const state = st.state.trim();
    if (!sceneIds.has(id)) {
      changes.push(`throughline: стан невідомої сцени «${st.sceneId}» викинуто`);
    } else if (byScene.has(id)) {
      changes.push(`throughline: дублікат стану сцени ${id} викинуто`);
    } else if (state) {
      byScene.set(id, state);
    }
  }
  const states = sb.scenes.map((scene) => {
    const state = byScene.get(scene.id);
    if (state) return { sceneId: scene.id, state };
    changes.push(`throughline: ${scene.id} без стану → «${THROUGHLINE_CARRIED_OVER}»`);
    return { sceneId: scene.id, state: THROUGHLINE_CARRIED_OVER };
  });
  sb.throughline = { object, states };
}

/** `events`: без дублікатів id, textIds — лише наявні пункти; legacy `sfxCue` → подія "arrive" на кадрі 0. */
function normalizeEventList(scene: Scene, changes: string[]): void {
  const itemIds = new Set(scene.items.map((i) => i.id));
  const seen = new Set<string>();
  const out: Scene["events"] = [];
  for (const e of scene.events ?? []) {
    if (seen.has(e.id)) {
      changes.push(`${scene.id}: дублікат події «${e.id}» викинуто`);
      continue;
    }
    seen.add(e.id);
    const textIds = [...new Set(e.textIds ?? [])].filter((id) => itemIds.has(id));
    out.push({ ...e, what: e.what.trim(), sound: e.sound ?? null, textIds });
  }
  // sfxCue лишається для старого шляху звуку (computeSfxPlacements); computeEventPlacements не дублює
  // його, бо сцена вже має подію "arrive".
  const cue = scene.sfxCue?.trim();
  if (cue && SOUND_CUES.includes(cue) && !seen.has(LEGACY_ARRIVE_EVENT_ID)) {
    out.unshift({
      id: LEGACY_ARRIVE_EVENT_ID,
      at: 0,
      what: "The scene arrives.",
      sound: { cue: cue as SoundCueT, accent: "normal" },
      textIds: [],
    });
    changes.push(`${scene.id}: sfxCue «${cue}» → подія «${LEGACY_ARRIVE_EVENT_ID}»`);
  }
  scene.events = out;
}

const SOUND_CUES: readonly string[] = SoundCue.options;

/** Найближча до `at` восьма (глобально: `from + at`) у межах сцени; немає — `at` без змін. */
function snapToGrid(at: number, from: number, last: number, half: number): number {
  const k = Math.round((from + at) / half);
  let best = at;
  let dist = Number.POSITIVE_INFINITY;
  for (const kk of [k, k - 1, k + 1]) {
    const local = Math.round(kk * half) - from;
    if (local < 0 || local > last) continue;
    if (Math.abs(local - at) < dist) {
      best = local;
      dist = Math.abs(local - at);
    }
  }
  return best;
}

/** Найпізніший `at` riser: перший кадр наступної сцени; в останній сцені — її останній кадр (не за кінцем ролика). */
function riserEnd(scene: Scene, last: boolean): number {
  return last ? scene.durationFrames - 1 : scene.durationFrames;
}

/**
 * Кадри подій після таймінгів: пропорційно до зміни тривалості сцени, у межах `[0, durationFrames − 1]`
 * (riser — `[0, riserEnd]`: закінчується на першому кадрі наступної сцени), cue з `GRID_SOUND_CUES` — на
 * найближчу восьму (решта йде за анімацією). Порядок — за кадром.
 */
function placeEvents(
  scene: Scene,
  opts: { from: number; modelDuration: number; half: number; changes: string[]; last: boolean },
): void {
  const end = riserEnd(scene, opts.last);
  const k = opts.modelDuration > 0 ? scene.durationFrames / opts.modelDuration : 1;
  let moved = 0;
  for (const e of scene.events) {
    const last = e.sound?.cue === "riser" ? end : scene.durationFrames - 1;
    let at = k === 1 ? e.at : Math.round(e.at * k);
    at = clamp(at, 0, last);
    // Подія "arrive" на кадрі 0 (з legacy sfxCue) лишається на початку сцени, як звучав старий sfxCue.
    const arrive = e.id === LEGACY_ARRIVE_EVENT_ID && at === 0;
    if (e.sound && GRID_SOUND_CUES.has(e.sound.cue) && !arrive)
      at = snapToGrid(at, opts.from, last, opts.half);
    if (at !== e.at) moved++;
    e.at = at;
  }
  scene.events.sort((a, b) => a.at - b.at);
  if (moved > 0) opts.changes.push(`${scene.id}: кадри подій уточнено (${moved})`);
}

/** Між двома важкими ударами — щонайменше стільки секунд. */
export const HIT_WINDOW_SEC = 3;
/** Секунд ролика на один важкий удар понад перший. */
const SEC_PER_HIT = 6;
/** riser довший за стільки тактів (4/4) до події — попередження. */
const RISER_MAX_BARS = 2;
/** Порядок пониження зайвих ударів: спершу `soft`, потім `normal`, `hard` — останніми. */
const ACCENT_RANK = { soft: 0, normal: 1, hard: 2 } as const;

/** Ліміт важких ударів на ролик: `1 + floor(totalSec / 6)` (24 с → 5). */
export function maxHits(totalSec: number): number {
  return 1 + Math.floor(totalSec / SEC_PER_HIT);
}

/** Подія "arrive" з legacy `sfxCue`: старий шлях звуку, її не чіпаємо і не рахуємо. */
function isLegacyArrive(scene: Scene, e: Scene["events"][number]): boolean {
  return e.id === LEGACY_ARRIVE_EVENT_ID && !!scene.sfxCue?.trim() && e.sound?.cue === scene.sfxCue.trim();
}

/**
 * riser закінчується на кадрі події (`computeEventPlacements`), тож має закінчитись рівно на ударі, до якого
 * наростає: якщо наступна озвучена подія (у цій або наступних сценах) не далі ніж пів долі від кінця riser —
 * `at` riser підтягується до її кадру, у межах сцени (≤ `riserEnd`). Після `placeEvents`.
 */
function pullRisers(sb: Storyboard, half: number, changes: string[]): void {
  const timeline = computeTimeline(sb);
  // Восьмі округлені до кадрів (при 7.5 кадра — то 7, то 8): сусідня восьма завжди в межах.
  const reach = Math.ceil(half);
  const all = sb.scenes.flatMap((scene, i) => {
    const from = timeline.scenes[i]?.from ?? 0;
    const end = riserEnd(scene, i === sb.scenes.length - 1);
    return scene.events.map((event) => ({ scene, event, from, end, frame: from + event.at }));
  });
  for (const p of all) {
    if (p.event.sound?.cue !== "riser" || isLegacyArrive(p.scene, p.event)) continue;
    let target: number | null = null;
    for (const q of all) {
      if (q === p || !q.event.sound || q.event.sound.cue === "riser" || q.frame < p.frame) continue;
      if (target === null || q.frame < target) target = q.frame;
    }
    if (target === null || target === p.frame || target - p.frame > reach) continue;
    const at = Math.min(target - p.from, p.end);
    if (at === p.event.at) continue;
    changes.push(
      `${p.scene.id}: riser «${p.event.id}» ${p.event.at} → ${at} — закінчується на наступній події`,
    );
    p.event.at = at;
  }
  for (const scene of sb.scenes) scene.events.sort((a, b) => a.at - b.at);
}

/**
 * Щільність ударів (після `placeEvents` і `pullRisers`, кадри вже остаточні):
 * - важкий удар (`HIT_SOUND_CUES`) ближче `HIT_WINDOW_SEC` до попереднього залишеного → `pop` (`normal`);
 * - понад `maxHits` на ролик → `pop` (`normal`), починаючи з `soft`, далі `normal`, далі `hard`,
 *   у межах рівня — за порядком у ролику;
 * - `riser` далі ніж за 2 такти до наступної озвученої події — лише попередження в `changes`.
 * Кадр події не змінюється. Legacy-події "arrive" з `sfxCue` не рахуються і не понижуються.
 */
export function limitHits(sb: Storyboard, changes: string[]): void {
  const timeline = computeTimeline(sb);
  const beat = beatFrames(sb.musicBrief.bpm, sb.fps);
  type Placed = { scene: Scene; event: Scene["events"][number]; frame: number; legacy: boolean };
  const all: Placed[] = [];
  sb.scenes.forEach((scene, i) => {
    const from = timeline.scenes[i]?.from ?? 0;
    for (const event of scene.events) {
      all.push({ scene, event, frame: from + event.at, legacy: isLegacyArrive(scene, event) });
    }
  });
  // Стабільне сортування: за рівних кадрів — у порядку сцен і подій.
  all.sort((a, b) => a.frame - b.frame);

  const accentOf = (p: Placed) => p.event.sound?.accent ?? "normal";
  const demote = (p: Placed, why: string) => {
    changes.push(
      `${p.scene.id}: подія «${p.event.id}» ${p.event.sound?.cue} (${accentOf(p)}) → pop — ${why}`,
    );
    p.event.sound = { cue: "pop", accent: "normal" };
  };

  // Вікно: другий удар ближче 3 с до попереднього залишеного понижується.
  const minGap = HIT_WINDOW_SEC * sb.fps;
  const kept: Placed[] = [];
  for (const p of all) {
    if (p.legacy || !p.event.sound || !HIT_SOUND_CUES.has(p.event.sound.cue)) continue;
    const prev = kept[kept.length - 1];
    if (prev && p.frame - prev.frame < minGap) demote(p, `ближче ${HIT_WINDOW_SEC} с до попереднього удару`);
    else kept.push(p);
  }

  // Ліміт на ролик: зайві — від найменш важливих.
  const limit = maxHits(timeline.totalFrames / sb.fps);
  if (kept.length > limit) {
    const order = kept
      .map((p, i) => ({ p, i }))
      .sort((a, b) => ACCENT_RANK[accentOf(a.p)] - ACCENT_RANK[accentOf(b.p)] || a.i - b.i);
    for (const { p } of order.slice(0, kept.length - limit)) {
      demote(p, `понад ліміт ${limit} ударів на ролик`);
    }
  }

  // riser: наростання до наступної озвученої події не довше за 2 такти.
  const maxLead = RISER_MAX_BARS * 4 * beat;
  all.forEach((p, i) => {
    if (p.legacy || p.event.sound?.cue !== "riser") return;
    const target = all.slice(i + 1).find((q) => q.event.sound && q.event.sound.cue !== "riser");
    if (!target || target.frame - p.frame <= maxLead) return;
    const beats = Math.round((target.frame - p.frame) / beat);
    changes.push(
      `${p.scene.id}: riser «${p.event.id}» за ${beats} долей до події «${target.event.id}» — довший за ${RISER_MAX_BARS} такти (попередження)`,
    );
  });
}

/**
 * Хук і фінал — на повному треку: частина структури, що першою містить першу чи останню сцену
 * (саме її бере зведення), отримує `mix: "full"`. Якщо в ній є й інші сцени, крайня сцена виноситься
 * в окрему частину (`hook` / `finale`) з тією ж енергією, а решта частини лишається як була.
 * Сцена без частини і так звучить `full`.
 */
export function enforceMusicEnds(sb: Storyboard, changes: string[]): void {
  const structure = sb.musicBrief.structure;
  const first = sb.scenes[0]?.id;
  const last = sb.scenes.at(-1)?.id;
  for (const [id, label] of [
    [first, "hook"],
    [last, "finale"],
  ] as const) {
    if (id === undefined) continue;
    const idx = structure.findIndex((p) => p.sceneIds.includes(id));
    const part = structure[idx];
    if (!part || part.mix === "full") continue;
    if (part.sceneIds.length === 1) {
      changes.push(`musicBrief: частина «${part.label}» (${id}) ${part.mix} → full`);
      part.mix = "full";
      continue;
    }
    part.sceneIds = part.sceneIds.filter((s) => s !== id);
    const own = { label, sceneIds: [id], energy: part.energy, mix: "full" as const };
    // Перед частиною для першої сцени, після — для останньої: порядок частин іде за сценами.
    structure.splice(id === first ? idx : idx + 1, 0, own);
    changes.push(
      `musicBrief: ${id} винесено з частини «${part.label}» (${part.mix}) в окрему «${label}» (full)`,
    );
  }
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
  // Дублікат id: стан лишається за першою сценою з цим id (вона id зберегла), перейменовується лише невідомий.
  normalizeThroughline(sb, (id) => (used.has(id) ? id : (renamed.get(id) ?? id)), changes);

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
    normalizeItems(scene, factSet, changes);
    normalizeEventList(scene, changes);
  }

  enforceMusicEnds(sb, changes);

  // ---------- темп ----------
  const bpm = snapBpm(sb.musicBrief.bpm);
  if (bpm !== sb.musicBrief.bpm) changes.push(`musicBrief.bpm ${sb.musicBrief.bpm} → ${bpm}`);
  sb.musicBrief.bpm = bpm;
  const beat = beatFrames(bpm, sb.fps);

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
  const modelDurations = sb.scenes.map((s) => s.durationFrames);
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
  const totalFrames = target ?? totalOf(d, t);
  const bar = beat * BEATS_PER_BAR;
  const breakdown = new Set(
    sb.musicBrief.structure.filter((p) => p.mix === "breakdown").flatMap((p) => p.sceneIds),
  );
  const shrink = sb.scenes.map((s) => (breakdown.has(s.id) ? 1 : SHRINK_WEIGHT));
  let onGrid = quantizeScenes(d, t, bar, totalFrames, bar / 2, shrink);
  if (!onGrid) {
    onGrid = quantizeScenes(d, t, beat, totalFrames, Number.POSITIVE_INFINITY, shrink);
    if (d.length > 1) changes.push("склейки — на долях: на такти лише зі зміною сцени понад пів такту");
  }
  if (onGrid) d.splice(0, d.length, ...onGrid);
  else quantizeToBeats(d, t, beat, totalFrames);

  sb.scenes.forEach((scene, i) => {
    const nd = d[i] as number;
    const nt = t[i] as number;
    if (nd !== scene.durationFrames) changes.push(`${scene.id}: ${scene.durationFrames} → ${nd} кадрів`);
    if (nt !== scene.transitionFrames) changes.push(`${scene.id}: перехід ${scene.transitionFrames} → ${nt}`);
    scene.durationFrames = nd;
    scene.transitionFrames = nt;
    if (i > 0 && nt === 0 && scene.transitionIn !== "cut") scene.transitionIn = "cut";
  });

  // ---------- події ----------
  const placed = computeTimeline(sb);
  sb.scenes.forEach((scene, i) => {
    placeEvents(scene, {
      from: placed.scenes[i]?.from ?? 0,
      modelDuration: modelDurations[i] ?? scene.durationFrames,
      half: beat / 2,
      changes,
      last: i === sb.scenes.length - 1,
    });
  });
  pullRisers(sb, beat / 2, changes);
  limitHits(sb, changes);

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
