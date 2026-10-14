/**
 * Еталон: motion blur на швидких рухах (заглушка Кроку 0, наповнює B1).
 */
import type { SceneProps } from "@adc/motion-kit";
import { Backdrop } from "@adc/motion-kit";
import { AbsoluteFill } from "remotion";

export default function Scene(_props: SceneProps) {
  return (
    <AbsoluteFill>
      <Backdrop variant="solid" />
    </AbsoluteFill>
  );
}
