import { createStereo, pcmLength, type StereoPcm } from "./pcm.ts";

/**
 * Ширина стерео музики (A11): ElevenLabs віддає трек майже моно (кореляція L/R ≈ 0.99).
 * Зведення викликає `widenMusic` після нормалізації музики, до автоматизації частин.
 */

/** Розширення стерео музики. Крок 0 — копія без змін (реалізація — A11). */
export function widenMusic(pcm: StereoPcm): StereoPcm {
  const out = createStereo(pcmLength(pcm), pcm.sampleRate);
  out.left.set(pcm.left);
  out.right.set(pcm.right);
  return out;
}
