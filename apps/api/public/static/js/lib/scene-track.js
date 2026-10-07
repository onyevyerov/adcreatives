// @ts-check
/**
 * Таймінги сцен для треку сценарію (B7) і скраббера готового ролика (B9) — чисті функції без DOM.
 *
 * `computeTimeline` — порт `computeTimeline` з `@adc/shared/timeline` (той самий результат і ті самі
 * помилки), без імпортів з пакетів: у браузер нічого з `@adc/shared` не потрапляє.
 *
 * Модель як у `TransitionSeries`: `durationFrames` — довжина послідовності сцени; перехід
 * перекриває кінець попередньої і початок поточної сцени. Загальна тривалість = сума сцен − сума
 * переходів.
 *
 * Що брати для чого:
 * - трек сценарію (B7): `trackLayout(timeline)` — блоки сцен без перекриттів + зони переходів;
 * - скраббер «Готово» (B9): `sceneSegments(timeline)` — суцільні відрізки, що покривають ролик
 *   від 0 до кінця без проміжків (межа сцени — середина переходу);
 * - шкала секунд: `secondMarks(durationSeconds)`;
 * - дані з чекпоінта 2: `timelineOf(state.checkpoints.script?.payload)` → `Timeline | null`.
 */

/**
 * @typedef {{
 *   id: string,
 *   index: number,
 *   from: number,
 *   durationInFrames: number,
 *   transitionInFrames: number,
 *   transitionOutFrames: number,
 *   end: number
 * }} TimelineScene
 * Сцена на таймлайні (= `TimelineScene` з `@adc/shared`): `from` — глобальний кадр початку
 * послідовності сцени; `end` — кадр після кінця (exclusive); `transitionInFrames` — перехід на
 * вході (0 для першої сцени і для склейки); `transitionOutFrames` — перехід на виході
 * (= `transitionInFrames` наступної сцени).
 */
/** @typedef {{ fps: number, totalFrames: number, durationSeconds: number, scenes: TimelineScene[] }} Timeline */
/**
 * Вхід — розкадровка (`Storyboard`) або будь-що з `fps` і сценами з `id`/`durationFrames`/`transitionFrames`.
 * @typedef {{ fps: number, scenes: ReadonlyArray<{ id: string, durationFrames: number, transitionFrames: number }> }} TimelineInput
 */

/** Помилка некоректних таймінгів (= `TimelineError` з `@adc/shared`). */
export class TimelineError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "TimelineError";
  }
}

/**
 * Таймлайн розкадровки — порт `computeTimeline` з `@adc/shared/timeline`.
 * @param {TimelineInput} storyboard
 * @returns {Timeline}
 * @throws {TimelineError} без сцен, нецілі/непозитивні тривалості, від'ємні переходи, перехід
 *   не коротший за сусідню сцену
 */
export function computeTimeline(storyboard) {
  const { fps, scenes } = storyboard;
  if (scenes.length === 0) throw new TimelineError("розкадровка без сцен");

  /** @type {TimelineScene[]} */
  const result = [];
  let cursor = 0;
  scenes.forEach((scene, index) => {
    if (!Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) {
      throw new TimelineError(`сцена ${scene.id}: durationFrames має бути цілим > 0`);
    }
    const transitionIn = index === 0 ? 0 : scene.transitionFrames;
    if (!Number.isInteger(transitionIn) || transitionIn < 0) {
      throw new TimelineError(`сцена ${scene.id}: transitionFrames має бути цілим ≥ 0`);
    }
    const prev = result[index - 1];
    if (prev && transitionIn > 0 && transitionIn >= Math.min(prev.durationInFrames, scene.durationFrames)) {
      throw new TimelineError(
        `сцена ${scene.id}: перехід ${transitionIn} кадрів не коротший за сусідню сцену`,
      );
    }
    const from = cursor - transitionIn;
    if (prev) prev.transitionOutFrames = transitionIn;
    result.push({
      id: scene.id,
      index,
      from,
      durationInFrames: scene.durationFrames,
      transitionInFrames: transitionIn,
      transitionOutFrames: 0,
      end: from + scene.durationFrames,
    });
    cursor = from + scene.durationFrames;
  });

  return { fps, totalFrames: cursor, durationSeconds: cursor / fps, scenes: result };
}

/**
 * Таймлайн без винятків: `null`, якщо розкадровки немає або таймінги некоректні.
 * @param {TimelineInput | null | undefined} storyboard
 * @returns {Timeline | null}
 */
export function tryTimeline(storyboard) {
  if (!storyboard || !Array.isArray(storyboard.scenes) || !(storyboard.fps > 0)) return null;
  try {
    return computeTimeline(storyboard);
  } catch (err) {
    if (err instanceof TimelineError) return null;
    throw err;
  }
}

/**
 * Таймлайн з payload чекпоінта 2 (`state.checkpoints.script?.payload`); для іншого payload або
 * некоректних таймінгів — `null` (B9 тоді показує один сегмент).
 * @param {{ checkpoint: string, storyboard?: TimelineInput } | null | undefined} payload
 * @returns {Timeline | null}
 */
export function timelineOf(payload) {
  if (payload?.checkpoint !== "script") return null;
  return tryTimeline(payload.storyboard);
}

/** @param {number} frame @param {number} total */
const pctOf = (frame, total) => (total > 0 ? (frame / total) * 100 : 0);

/**
 * Блок сцени на треку: частина сцени без перекриттів переходами,
 * `[from + transitionInFrames, end − transitionOutFrames)`.
 * @typedef {{ id: string, index: number, startFrame: number, endFrame: number, leftPct: number, widthPct: number }} TrackBlock
 */
/**
 * Зона переходу між сценами `fromIndex` і `toIndex = fromIndex + 1` (`[from, from + transitionInFrames)`
 * наступної сцени). Лише для `transitionFrames > 0`.
 * @typedef {{ fromIndex: number, toIndex: number, startFrame: number, endFrame: number, frames: number, leftPct: number, widthPct: number }} TrackTransition
 */
/** @typedef {{ totalFrames: number, blocks: TrackBlock[], transitions: TrackTransition[] }} TrackLayout */

/**
 * Геометрія треку сценарію: блоки сцен і зони переходів у відсотках від загальної тривалості.
 * Блоки й зони не перекриваються і разом покривають `[0, totalFrames)`.
 * @param {Timeline} timeline
 * @returns {TrackLayout}
 */
export function trackLayout(timeline) {
  const total = timeline.totalFrames;
  /** @type {TrackBlock[]} */
  const blocks = [];
  /** @type {TrackTransition[]} */
  const transitions = [];
  for (const s of timeline.scenes) {
    const startFrame = s.from + s.transitionInFrames;
    const endFrame = s.end - s.transitionOutFrames;
    blocks.push({
      id: s.id,
      index: s.index,
      startFrame,
      endFrame,
      leftPct: pctOf(startFrame, total),
      widthPct: pctOf(endFrame - startFrame, total),
    });
    if (s.transitionInFrames > 0) {
      transitions.push({
        fromIndex: s.index - 1,
        toIndex: s.index,
        startFrame: s.from,
        endFrame: s.from + s.transitionInFrames,
        frames: s.transitionInFrames,
        leftPct: pctOf(s.from, total),
        widthPct: pctOf(s.transitionInFrames, total),
      });
    }
  }
  return { totalFrames: total, blocks, transitions };
}

/**
 * Відрізок сцени для скраббера: межа між сценами — середина переходу (для склейки — кадр стику).
 * Відрізки суцільні: `segments[0].startFrame === 0`, `segments[i].endFrame === segments[i + 1].startFrame`,
 * останній закінчується на `totalFrames`. Секунди — `кадри / fps`.
 * @typedef {{
 *   id: string, index: number,
 *   startFrame: number, endFrame: number,
 *   startSeconds: number, endSeconds: number,
 *   startPct: number, endPct: number
 * }} SceneSegment
 */

/**
 * Суцільні відрізки сцен від 0 до кінця ролика (межі сегментів скраббера B9).
 * @param {Timeline} timeline
 * @returns {SceneSegment[]}
 */
export function sceneSegments(timeline) {
  const { fps, totalFrames: total, scenes } = timeline;
  /** @param {number} i межа перед сценою i */
  const boundary = (i) => {
    const s = scenes[i];
    if (!s) return total;
    return i === 0 ? 0 : s.from + s.transitionInFrames / 2;
  };
  return scenes.map((s, i) => {
    const startFrame = boundary(i);
    const endFrame = boundary(i + 1);
    return {
      id: s.id,
      index: s.index,
      startFrame,
      endFrame,
      startSeconds: startFrame / fps,
      endSeconds: endFrame / fps,
      startPct: pctOf(startFrame, total),
      endPct: pctOf(endFrame, total),
    };
  });
}

/**
 * Індекс сцени, якій належить момент `seconds` за `sceneSegments` (для підсвітки поточного
 * сегмента скраббера). Поза межами — перша/остання сцена.
 * @param {SceneSegment[]} segments
 * @param {number} seconds
 * @returns {number}
 */
export function segmentIndexAt(segments, seconds) {
  if (segments.length === 0) return -1;
  for (let i = 0; i < segments.length; i++) {
    const seg = /** @type {SceneSegment} */ (segments[i]);
    if (seconds < seg.endSeconds) return i;
  }
  return segments.length - 1;
}

/**
 * Позначка шкали секунд: `major` — з підписом (кожні `labelEvery` с, плюс 0).
 * @typedef {{ seconds: number, pct: number, major: boolean }} SecondMark
 */

/**
 * Позначки шкали секунд під треком: кожна ціла секунда від 0 до тривалості включно.
 * @param {number} durationSeconds
 * @param {number} [labelEvery] крок підписаних позначок, с (за замовчуванням 5)
 * @returns {SecondMark[]}
 */
export function secondMarks(durationSeconds, labelEvery = 5) {
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) return [];
  const step = labelEvery > 0 ? labelEvery : 5;
  /** @type {SecondMark[]} */
  const out = [];
  for (let s = 0; s <= Math.floor(durationSeconds + 1e-9); s++) {
    out.push({ seconds: s, pct: (s / durationSeconds) * 100, major: s % step === 0 });
  }
  return out;
}

/**
 * Секунди з однією цифрою після коми (десятковий роздільник — кома): 15 → «15,0», 5.5 → «5,5».
 * @param {number} seconds
 * @returns {string}
 */
export function formatSeconds(seconds) {
  const n = Number.isFinite(seconds) ? seconds : 0;
  return n.toFixed(1).replace(".", ",");
}
