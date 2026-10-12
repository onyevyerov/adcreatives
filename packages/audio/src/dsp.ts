/** Мінімальні фільтри для зведення й синтезу (біквад RBJ і SVF), без залежностей. */

/** Біквад-фільтр (transposed direct form II); коефіцієнти можна міняти на льоту. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  /** Low-pass RBJ: зріз `cutoffHz`, добротність `q` (0.707 — Баттерворт). */
  setLowpass(cutoffHz: number, sampleRate: number, q = Math.SQRT1_2): this {
    const fc = Math.min(cutoffHz, sampleRate * 0.49);
    const w0 = (2 * Math.PI * fc) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** State-variable filter (Cytomic, TPT): стабільний при швидкій зміні зрізу — для свіпів шуму. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  low = 0;
  band = 0;
  high = 0;

  process(x: number, cutoffHz: number, q: number, sampleRate: number): void {
    const g = Math.tan((Math.PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = x - k * v1 - v2;
  }
}
