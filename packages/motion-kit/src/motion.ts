import type { MotionPersonality } from "@adc/shared/schemas/brandkit";
import { Easing, interpolate, type SpringConfig } from "remotion";

export type { SpringConfig };
export type EasingFn = (t: number) => number;

/** Пресети spring() для remotion: `spring({ frame, fps, config: springs.soft })`. */
export const springs: { snappy: SpringConfig; soft: SpringConfig; premium: SpringConfig } = {
  /** Швидко, з легким перельотом — ціни, бейджі, кнопки. */
  snappy: { damping: 14, mass: 0.6, stiffness: 180, overshootClamping: false },
  /** Без перельоту — основний текст, фото. */
  soft: { damping: 200, mass: 1, stiffness: 100, overshootClamping: false },
  /** Повільно і щільно — преміальні бренди, лого. */
  premium: { damping: 30, mass: 1.4, stiffness: 70, overshootClamping: true },
};

/** Easing-функції для `interpolate(..., { easing })`. */
export const easings: { out: EasingFn; inOut: EasingFn; expoOut: EasingFn; backOut: EasingFn } = {
  out: Easing.out(Easing.cubic),
  inOut: Easing.inOut(Easing.cubic),
  expoOut: Easing.out(Easing.exp),
  backOut: Easing.out(Easing.back(1.6)),
};

/** Хелпер: 0→1 від startFrame за duration кадрів з easing (clamp). */
export function progress(frame: number, startFrame: number, duration: number, easing?: EasingFn): number {
  if (duration <= 0) return frame >= startFrame ? 1 : 0;
  return interpolate(frame, [startFrame, startFrame + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    ...(easing ? { easing } : {}),
  });
}

/** Пружина за характером руху бренду. */
export function springFor(motion: MotionPersonality): SpringConfig {
  switch (motion) {
    case "energetic":
    case "playful":
      return springs.snappy;
    case "premium":
      return springs.premium;
    case "calm":
      return springs.soft;
  }
}

/** Кадрів між елементами кінетичного тексту за характером руху. */
export function defaultStagger(motion: MotionPersonality, by: "word" | "line"): number {
  const perWord: Record<MotionPersonality, number> = { energetic: 3, playful: 4, calm: 5, premium: 6 };
  return by === "word" ? perWord[motion] : Math.round(perWord[motion] * 2.5);
}
