import { measureLoudness, truePeakDb } from "./loudness.ts";
import { createStereo, dbToGain, pcmLength, type StereoPcm, secToSamples } from "./pcm.ts";

/**
 * Мастер зведення: сума музики, подій і реверба → готовий `soundtrack.wav`.
 * Зараз — м'який кліпер (tanh від −6 dBFS, стеля −1 dBFS) без підсилення суми й антиклік
 * у кінці; гучність і true peak результату міряються (BS.1770-4). LUFS-мастер — A4.
 */

export const MASTER_CEILING_DBFS = -1;
const MASTER_KNEE_DBFS = -6;
/** Короткий антиклік мастера в кінці ролика. */
const MASTER_END_FADE_SEC = 0.01;

export interface MasterResult {
  pcm: StereoPcm;
  /** Підсилення суми до кліпера, дБ. */
  gainDb: number;
  /** Інтегральна гучність результату, LUFS (−Infinity — тиша). */
  integratedLufs: number;
  /** True peak результату, dBTP. */
  truePeakDbtp: number;
}

const softClip = (x: number, knee: number, ceiling: number) => {
  const a = Math.abs(x);
  if (a <= knee) return x;
  return Math.sign(x) * (knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
};

/** Мастер: м'який кліпер (пік < −1 dBFS) → антиклік у кінці. Нова копія; той самий вхід → той самий вихід. */
export function masterize(sum: StereoPcm, opts: { sampleRate: number }): MasterResult {
  const total = pcmLength(sum);
  const out = createStereo(total, opts.sampleRate);
  const knee = dbToGain(MASTER_KNEE_DBFS);
  const ceiling = dbToGain(MASTER_CEILING_DBFS);
  const endFade = Math.min(total, secToSamples(MASTER_END_FADE_SEC, opts.sampleRate));
  for (let j = 0; j < total; j++) {
    const tail = j >= total - endFade ? (total - 1 - j) / Math.max(1, endFade) : 1;
    out.left[j] = softClip(sum.left[j] as number, knee, ceiling) * tail;
    out.right[j] = softClip(sum.right[j] as number, knee, ceiling) * tail;
  }
  return {
    pcm: out,
    gainDb: 0,
    integratedLufs: measureLoudness(out).integratedLufs,
    truePeakDbtp: truePeakDb(out),
  };
}
