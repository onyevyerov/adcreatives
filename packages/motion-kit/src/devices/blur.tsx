import type { JSX, ReactNode } from "react";

// Субкадровий motion blur і шлейф (@remotion/motion-blur). Заглушки Кроку 0: сигнатури заморожені,
// реалізацію дає B1 — до того обидва повертають дітей без змін.

/** Субкадровий motion blur: `samples` проміжних кадрів у межах `shutterAngle` змішуються (@remotion/motion-blur CameraMotionBlur). */
export function MotionBlur(props: {
  /** 3 */
  samples?: number;
  /** 180 */
  shutterAngle?: number;
  children: ReactNode;
}): JSX.Element {
  return <>{props.children}</>;
}

/** Шлейф: `layers` копій дітей із відставанням `lagInFrames`, прозорість спадає до `trailOpacity` (@remotion/motion-blur Trail). */
export function Trail(props: {
  /** 3 */
  layers?: number;
  /** 1 */
  lagInFrames?: number;
  /** 0.4 */
  trailOpacity?: number;
  children: ReactNode;
}): JSX.Element {
  return <>{props.children}</>;
}
