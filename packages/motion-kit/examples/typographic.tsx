/**
 * Еталон: типографічна сцена без фото. Великий текст на кольоровому фоні з підсвіткою акцентів,
 * декоративне коло з @remotion/shapes повільно росте.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  KineticText,
  readableOn,
  SafeArea,
  springs,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { Circle } from "@remotion/shapes";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const format = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { headline, sub, emphasis } = props.scene.text;
  const color = readableOn(theme.palette.primary, theme.palette);
  const grow = spring({ frame, fps, config: springs.premium });
  const radius = Math.min(format.width, format.height) * 0.42 * grow;

  return (
    <AbsoluteFill>
      <Backdrop variant="solid" color={theme.palette.primary} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: 0.18 }}>
        <Circle radius={Math.max(1, radius)} fill={theme.palette.secondary} />
      </AbsoluteFill>
      <SafeArea style={{ justifyContent: "center", gap: 32 * format.unit }}>
        <KineticText
          text={headline}
          preset="highlight"
          by="word"
          emphasis={emphasis}
          maxLines={4}
          maxFontSize={Math.round(140 * format.unit)}
          minFontSize={Math.round(56 * format.unit)}
          color={color}
        />
        {sub ? <Body text={sub} preset="rise" startFrame={30} color={color} /> : null}
      </SafeArea>
    </AbsoluteFill>
  );
}
