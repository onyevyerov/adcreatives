/** Мінімальний фільтр для зведення (біквад RBJ), без залежностей. */

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
