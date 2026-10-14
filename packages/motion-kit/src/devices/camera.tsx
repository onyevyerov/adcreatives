import { createContext, type JSX, type ReactNode, useContext } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { useFormat } from "../format.tsx";
import { type EasingFn, easings, progress } from "../motion.ts";

// Віртуальна камера сцени: шар на весь кадр, що наїжджає на прямокутник ключа і відходить.
// Чиста функція кадру; один рух за раз — ключі, що перекриваються в часі, дають помилку рендеру (R3).

/** Ключ камери: з кадру `at` камера наїжджає на прямокутник `x, y, width, height` (px кадру). */
export interface CameraKey {
  at: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CameraState {
  active: boolean;
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: CameraState = { active: false, scale: 1, tx: 0, ty: 0 };
const CameraContext = createContext<CameraState>(IDENTITY);

/**
 * Трансформація, що вписує прямокутник `r` у кадр `width × height` і ставить його центр у центр кадру:
 * точка `p` шару переходить у `scale · p + (tx, ty)` (`transformOrigin: 0 0`).
 */
function fit(r: Omit<CameraKey, "at">, width: number, height: number): Omit<CameraState, "active"> {
  const scale = Math.min(width / r.width, height / r.height);
  return {
    scale,
    tx: width / 2 - scale * (r.x + r.width / 2),
    ty: height / 2 - scale * (r.y + r.height / 2),
  };
}

/** Віртуальна камера: шар на весь кадр, що наїжджає на прямокутник ключа (масштаб + зсув), один рух за раз. */
export function Camera(props: {
  keys: CameraKey[];
  /** 18 */
  duration?: number;
  easing?: EasingFn;
  children: ReactNode;
}): JSX.Element {
  const { width, height } = useFormat();
  const frame = useCurrentFrame();
  const duration = props.duration ?? 18;
  const easing = props.easing ?? easings.inOut;
  const { keys } = props;

  keys.forEach((key, i) => {
    if (!(key.width > 0 && key.height > 0)) {
      throw new Error(`Camera: ключ ${i} без розміру (${key.width}×${key.height})`);
    }
    // Перший ключ — стан з кадру 0, а не рух; рухи — ключі з 1-го, і жоден не стартує, поки триває попередній.
    const prev = keys[i - 1];
    if (i >= 2 && prev && key.at < prev.at + duration) {
      throw new Error(
        `Camera: два рухи одночасно — ключ ${i} стартує на кадрі ${key.at}, а рух до ключа ${i - 1} триває до кадру ${prev.at + duration}`,
      );
    }
  });

  // Стан — прямокутник, на який дивиться камера: послідовна інтерполяція від першого ключа (як у MorphShape).
  const first = keys[0];
  const r = first
    ? { x: first.x, y: first.y, width: first.width, height: first.height }
    : { x: 0, y: 0, width, height };
  for (const key of keys.slice(1)) {
    const t = progress(frame, key.at, duration, easing);
    if (t <= 0) break;
    const lerp = (a: number, b: number) => a + (b - a) * t;
    r.x = lerp(r.x, key.x);
    r.y = lerp(r.y, key.y);
    r.width = lerp(r.width, key.width);
    r.height = lerp(r.height, key.height);
  }
  const { scale, tx, ty } = fit(r, width, height);

  return (
    <CameraContext.Provider value={{ active: true, scale, tx, ty }}>
      <AbsoluteFill
        style={{
          transformOrigin: "0 0",
          transform: `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`,
        }}
      >
        {props.children}
      </AbsoluteFill>
    </CameraContext.Provider>
  );
}

/** Поточна трансформація камери для перевірок QA; identity поза Camera. */
export function useCamera(): { active: boolean; scale: number; tx: number; ty: number } {
  return useContext(CameraContext);
}
