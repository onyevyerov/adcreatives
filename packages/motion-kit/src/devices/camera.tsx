import type { JSX, ReactNode } from "react";
import type { EasingFn } from "../motion.ts";

// Віртуальна камера сцени. Заглушка Кроку 0: сигнатури заморожені, реалізацію дає B2 —
// до того `Camera` повертає дітей без змін, а `useCamera` — identity.

/** Ключ камери: з кадру `at` камера наїжджає на прямокутник `x, y, width, height` (px кадру). */
export interface CameraKey {
  at: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Віртуальна камера: шар на весь кадр, що наїжджає на прямокутник ключа (масштаб + зсув), один рух за раз. */
export function Camera(props: {
  keys: CameraKey[];
  /** 18 */
  duration?: number;
  easing?: EasingFn;
  children: ReactNode;
}): JSX.Element {
  return <>{props.children}</>;
}

/** Поточна трансформація камери для перевірок QA; identity поза Camera. */
export function useCamera(): { active: boolean; scale: number; tx: number; ty: number } {
  return { active: false, scale: 1, tx: 0, ty: 0 };
}
