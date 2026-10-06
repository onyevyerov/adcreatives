/**
 * Еталон: соціальний доказ. Рейтинг рахується від 0 до значення з бренд-кіта,
 * зірки з'являються по черзі, заголовок і підпис — нижче.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  easings,
  Headline,
  headingWeight,
  progress,
  readableOn,
  SafeArea,
  springs,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { Star } from "@remotion/shapes";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { headline, sub, emphasis } = props.scene.text;
  const rating = props.brand.socialProof.rating;
  const color = readableOn(theme.palette.surface, theme.palette);
  const shown = rating === null ? null : rating * progress(frame, 0, 30, easings.expoOut);
  const starSize = 48 * unit;

  return (
    <AbsoluteFill>
      <Backdrop variant="noise" color={theme.palette.surface} />
      <SafeArea style={{ justifyContent: "center", alignItems: "center", gap: 32 * unit }}>
        {shown === null ? null : (
          <div
            style={{
              fontFamily: theme.fonts.heading,
              fontWeight: headingWeight(theme),
              fontSize: 160 * unit,
              color,
              lineHeight: 1,
            }}
          >
            {shown.toFixed(1)}
          </div>
        )}
        <div style={{ display: "flex", gap: 12 * unit }}>
          {[0, 1, 2, 3, 4].map((i) => {
            const s = spring({ frame: frame - 6 - i * 4, fps, config: springs.snappy });
            return (
              <div key={i} style={{ transform: `scale(${s})` }}>
                <Star
                  points={5}
                  innerRadius={starSize * 0.42}
                  outerRadius={starSize}
                  fill={theme.palette.accent}
                />
              </div>
            );
          })}
        </div>
        <Headline text={headline} emphasis={emphasis} preset="fade" startFrame={20} size="m" color={color} />
        {sub ? <Body text={sub} preset="fade" startFrame={30} size="s" color={color} /> : null}
      </SafeArea>
    </AbsoluteFill>
  );
}
