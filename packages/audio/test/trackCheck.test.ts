import { MusicTrackCheck } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { createStereo, pcmLength } from "../src/pcm.ts";
import {
  barMs,
  betterCheck,
  checkTrack,
  chooseWindowOffset,
  cutWindow,
  gapOverlapMs,
} from "../src/trackCheck.ts";
import { steadyBed } from "./signals.ts";
import { groove, withGaps } from "./trackSignals.ts";

const SR = 44_100;
const steady = groove(120, 23);

describe("checkTrack", () => {
  it("рівний грув: бочка на кожну долю, без провалів → ok", () => {
    const check = checkTrack(steady, 120, { videoMs: 15_000 });
    expect(MusicTrackCheck.parse(check)).toEqual(check);
    expect(check.ok).toBe(true);
    expect(check.bpm).toBe(120);
    expect(check.gaps).toEqual([]);
    // 23 с × 2 долі/с = 46 бочок; онсетів не менше за 0.8 на долю.
    expect(check.kickOnsets).toBeGreaterThanOrEqual(0.8 * 46);
    expect(check.beatConfidence).toBeGreaterThan(0.8);
    expect(check.rmsPerSecondDb).toHaveLength(23);
  });

  it("замір треку: кореляція L/R, LUFS і true peak; тональність і такт — заглушки (null)", () => {
    const check = checkTrack(steady, 120, { videoMs: 15_000 });
    expect(check.keyDetected).toBeNull();
    expect(check.barOffsetMs).toBeNull();
    expect(check.barConfidence).toBeNull();
    expect(check.stereoCorrelation).toEqual(expect.any(Number));
    expect(check.lowCorrelation).toBeGreaterThan(0.9);
    expect(check.integratedLufs).toBeLessThan(0);
    expect(check.integratedLufs).toBeGreaterThan(-40);
    expect(check.truePeakDbtp).toBeGreaterThan(check.integratedLufs as number);
    // Тиша: LUFS не визначений → null (у JSON нескінченність не пишеться).
    const silent = checkTrack(createStereo(3 * SR, SR), 120);
    expect(silent.integratedLufs).toBeNull();
    expect(MusicTrackCheck.parse(JSON.parse(JSON.stringify(silent)))).toEqual(silent);
  });

  it("стоп на 2 с усередині відео → провал > 1 с з падінням > 6 дБ, ok=false", () => {
    const pcm = withGaps(steady, [{ fromSec: 6, toSec: 8 }]);
    const check = checkTrack(pcm, 120, { videoMs: 15_000 });
    expect(check.ok).toBe(false);
    expect(check.gaps).toHaveLength(1);
    const gap = check.gaps[0];
    // Межі — з точністю до пів вікна (вікно = доля, не коротше 500 мс).
    expect(Math.abs((gap?.fromMs ?? 0) - 6_000)).toBeLessThanOrEqual(250);
    expect(Math.abs((gap?.toMs ?? 0) - 8_000)).toBeLessThanOrEqual(250);
    expect(gap?.dropDb).toBeGreaterThan(6);
    // Той самий провал після вікна відео ok не псує.
    expect(checkTrack(pcm, 120, { videoMs: 5_000 }).ok).toBe(true);
  });

  it("85 BPM (доля — не ціле число семплів): провал теж знаходиться", () => {
    const pcm = withGaps(groove(85, 23), [{ fromSec: 10, toSec: 12 }]);
    const check = checkTrack(pcm, 85, { videoMs: 15_000 });
    expect(check.ok).toBe(false);
    expect(check.gaps).toHaveLength(1);
    expect(Math.abs((check.gaps[0]?.fromMs ?? 0) - 10_000)).toBeLessThanOrEqual(400);
  });

  it("брейкдаун −12 дБ на 3 с — теж провал; dropDb близько 12", () => {
    const pcm = withGaps(steady, [{ fromSec: 4, toSec: 7, gain: 10 ** (-12 / 20) }]);
    const check = checkTrack(pcm, 120, { videoMs: 15_000 });
    expect(check.ok).toBe(false);
    expect(check.gaps).toHaveLength(1);
    expect(check.gaps[0]?.dropDb).toBeGreaterThan(9);
    expect(check.gaps[0]?.dropDb).toBeLessThan(15);
  });

  it("короткий провал (0.75 с) і тихіше на 4 дБ — не провали", () => {
    const short = checkTrack(withGaps(steady, [{ fromSec: 5, toSec: 5.75 }]), 120, { videoMs: 15_000 });
    expect(short.gaps).toEqual([]);
    expect(short.ok).toBe(true);
    const soft = withGaps(steady, [{ fromSec: 4, toSec: 9, gain: 10 ** (-4 / 20) }]);
    expect(checkTrack(soft, 120, { videoMs: 15_000 }).gaps).toEqual([]);
  });

  it("трек без бочки (рівний пед із шумом) → ok=false через онсети", () => {
    const check = checkTrack(steadyBed(16), 120, { videoMs: 15_000 });
    expect(check.gaps).toEqual([]);
    expect(check.ok).toBe(false);
  });

  it("тиша → ok=false, без падінь", () => {
    const silent = withGaps(steady, [{ fromSec: 0, toSec: 23 }]);
    const check = checkTrack(silent, 120);
    expect(check.ok).toBe(false);
    expect(check.kickOnsets).toBe(0);
  });
});

describe("вікно відео в треку", () => {
  const opts = { trackMs: 23_000, videoMs: 15_000, tailMs: 1_000, bpm: 120 };

  it("зсув — перший кратний такту, з яким вікно без провалів", () => {
    expect(barMs(120)).toBe(2_000);
    expect(chooseWindowOffset([], opts)).toBe(0);
    // Провал на 2–3.5 с: зсув 2 с ще зачіпає його, 4 с — ні.
    const gaps = [{ fromMs: 2_000, toMs: 3_500, dropDb: 20 }];
    expect(gapOverlapMs(gaps, 2_000, 15_000)).toBe(1_500);
    expect(chooseWindowOffset(gaps, opts)).toBe(4_000);
    // Провал наприкінці треку (після вікна) — зсуву нема.
    expect(chooseWindowOffset([{ fromMs: 17_000, toMs: 19_000, dropDb: 20 }], opts)).toBe(0);
  });

  it("неминучий провал → вікно з найменшим перекриттям; зсув не виходить за трек", () => {
    // Провал 6–8 с не обійти: вікно 15 с + 1 с хвоста в 23 с дає зсув ≤ 6 с.
    const gaps = [
      { fromMs: 0, toMs: 1_500, dropDb: 20 },
      { fromMs: 6_500, toMs: 8_000, dropDb: 20 },
    ];
    const offset = chooseWindowOffset(gaps, opts);
    expect(offset % 2_000).toBe(0);
    expect(offset + opts.videoMs + opts.tailMs).toBeLessThanOrEqual(opts.trackMs);
    expect(gapOverlapMs(gaps, offset, opts.videoMs)).toBe(1_500);
    expect(offset).toBe(2_000);
    // Трек не довший за відео — зсуву нема.
    expect(chooseWindowOffset(gaps, { ...opts, trackMs: 15_500 })).toBe(0);
  });

  it("cutWindow: вікно з потрібного місця і потрібної довжини, без довжини понад наявну", () => {
    const cut = cutWindow(steady, 4_000, 16_000);
    expect(pcmLength(cut)).toBe(16 * SR);
    const i = 2 * SR;
    expect(cut.left[i]).toBe(steady.left[4 * SR + i]);
    expect(cut.right[i]).toBe(steady.right[4 * SR + i]);
    expect(pcmLength(cutWindow(steady, 20_000, 16_000))).toBe(3 * SR);
    expect(pcmLength(cutWindow(steady, 0, 16_000))).toBe(16 * SR);
  });

  it("провал на початку: вибране вікно після обрізання проходить перевірку", () => {
    const pcm = withGaps(steady, [{ fromSec: 2, toSec: 3.5 }]);
    const raw = checkTrack(pcm, 120, { videoMs: 15_000 });
    expect(raw.ok).toBe(false);
    const offset = chooseWindowOffset(raw.gaps, opts);
    expect(offset).toBe(4_000);
    const cut = cutWindow(pcm, offset, 16_000);
    expect(checkTrack(cut, 120, { videoMs: 15_000 })).toMatchObject({ ok: true, gaps: [] });
  });
});

describe("betterCheck", () => {
  const base = checkTrack(steady, 120, { videoMs: 15_000 });
  it("пройдена перевірка краща; далі — менше провалів, далі — більше онсетів", () => {
    const gap = { fromMs: 1_000, toMs: 3_000, dropDb: 20 };
    const failed = { ...base, ok: false, gaps: [gap] };
    expect(betterCheck(base, failed)).toBe(true);
    expect(betterCheck(failed, base)).toBe(false);
    const twoGaps = { ...failed, gaps: [gap, gap] };
    expect(betterCheck(failed, twoGaps)).toBe(true);
    expect(betterCheck({ ...failed, kickOnsets: 40 }, { ...failed, kickOnsets: 30 })).toBe(true);
    expect(betterCheck({ ...failed, kickOnsets: 30 }, { ...failed, kickOnsets: 30 })).toBe(false);
  });
});
