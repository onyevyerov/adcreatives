import { CameraMotionBlur, Trail as TrailLayers } from "@remotion/motion-blur";
import type { JSX, ReactNode } from "react";
import { Freeze, useCurrentFrame } from "remotion";
import { QaProvider, useQaEnabled } from "../qa.tsx";

// Субкадровий motion blur і шлейф поверх @remotion/motion-blur. Обидва рендерять кілька копій дітей,
// кожну у своєму <Freeze>; QA-перевірки (text_overflow, safe-зона, контраст) лишаються лише в одній
// копії — основній, решта рендериться у <QaProvider enabled={false}>, щоб зауваження не множилися.
// Копію впізнаємо за кадром усередині її Freeze: інших відмінностей між копіями бібліотека не дає.

/** Більше семплів / шарів не даємо: кожен множить вартість рендеру піддерева. */
const MAX_COPIES = 6;
/** Допуск порівняння дробових кадрів Freeze (крок між семплами ≥ 1/360/6 кадру). */
const EPS = 1e-6;

/** Ціле зі скінченного числа, інакше — дефолт. */
function whole(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.round(value) : fallback;
}

function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/** Субкадровий motion blur: `samples` проміжних кадрів у межах `shutterAngle` змішуються (@remotion/motion-blur CameraMotionBlur). */
export function MotionBlur(props: {
  /** 3 */
  samples?: number;
  /** 180 */
  shutterAngle?: number;
  children: ReactNode;
}): JSX.Element {
  const frame = useCurrentFrame();
  const samples = Math.min(MAX_COPIES, whole(props.samples, 3));
  const shutterAngle = Math.min(360, finite(props.shutterAngle, 180));
  if (samples <= 1 || shutterAngle <= 0) return <>{props.children}</>;
  // CameraMotionBlur кладе семпл k (1…n) на кадр frame − (shutterAngle / 360) · k / n + 1. Основний —
  // k = n: найраніший і найближчий до поточного кадру; він же єдиний, коли біля кадру 0 семплів менше.
  const mainAt = frame - shutterAngle / 360 + 1;
  return (
    <CameraMotionBlur samples={samples} shutterAngle={shutterAngle}>
      <BlurSample mainAt={mainAt} frame={frame}>
        {props.children}
      </BlurSample>
    </CameraMotionBlur>
  );
}

/**
 * Одна копія всередині CameraMotionBlur. Основна копія (кадр ≤ mainAt; «<» лише коли Remotion
 * обрізав кадри семплів кінцем композиції — тоді всі копії однакові й однакові їхні QA-записи)
 * зберігає QA. У QA-режимі її ще й закріплено на цілому поточному кадрі: QaLogEntry.frame — ціле
 * (дробовий запис стадія check відкидає), і перевіряти треба геометрію саме цього кадру. Поза
 * QA-режимом (фінальний рендер, Studio) семпли — точно ті, що дає бібліотека.
 */
function BlurSample(props: { mainAt: number; frame: number; children: ReactNode }) {
  const at = useCurrentFrame();
  const qa = useQaEnabled();
  if (at > props.mainAt + EPS) return <QaProvider enabled={false}>{props.children}</QaProvider>;
  if (!qa) return <>{props.children}</>;
  return <Freeze frame={props.frame}>{props.children}</Freeze>;
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
  const frame = useCurrentFrame();
  const layers = Math.min(MAX_COPIES, whole(props.layers, 3));
  const lagInFrames = finite(props.lagInFrames, 1);
  const trailOpacity = Math.min(1, finite(props.trailOpacity, 0.4));
  if (layers <= 0 || lagInFrames <= 0 || trailOpacity <= 0) return <>{props.children}</>;
  return (
    <TrailLayers layers={layers} lagInFrames={lagInFrames} trailOpacity={trailOpacity}>
      <TrailCopy frame={frame}>{props.children}</TrailCopy>
    </TrailLayers>
  );
}

/** Шар Trail: копії заморожені на frame − lagInFrames · k, основний шар (без Freeze) — на frame. */
function TrailCopy(props: { frame: number; children: ReactNode }) {
  const at = useCurrentFrame();
  if (at < props.frame - EPS) return <QaProvider enabled={false}>{props.children}</QaProvider>;
  return <>{props.children}</>;
}
