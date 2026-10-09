/**
 * Соціальний доказ без фото: п'ять акцентних зірок (форми з @remotion/shapes, не гліфи)
 * заходять по черзі пружиною бренду, заголовок — слідом за останньою зіркою, підпис — за ним.
 * На екрані лише тексти сцени: цифра рейтингу з'являється тільки якщо режисер поклав її
 * в headline (emphasis її підсвітить); з бренд-кіта сцена не малює нічого.
 * Старти виводяться з довжини сцени, вхідного переходу, кількості слів і темпу бренду.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  defaultStagger,
  Headline,
  readableOn,
  SafeArea,
  springFor,
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
  const d = props.durationInFrames;
  const color = readableOn(theme.palette.surface, theme.palette);

  // Перший біт — не раніше, ніж закінчиться вхідний перехід: поява під fade невидима.
  const start = props.scene.transitionFrames;
  // Усе, що треба прочитати, має стояти на місці приблизно до чверті сцени:
  // перевірки дивляться кадри на 50 % і 90 %.
  const readyBy = Math.round(d * 0.25);
  // Зірки заходять з тим самим кроком і пружиною, що й слова заголовка в цього бренду.
  const stagger = defaultStagger(theme.motion, "word");
  const starSpring = springFor(theme.motion);
  const lastStarAt = start + 4 * stagger;
  // Заголовок (preset fade, по словах) читабельний через (слів − 1) × stagger + 12 кадрів після старту.
  const words = headline.split(/\s+/).filter(Boolean).length;
  const headlineNeeds = (words - 1) * stagger + 12;
  // Заголовок стартує, коли заходить остання зірка, — або раніше, якщо інакше не встигне до readyBy
  // (коротка сцена, довгий заголовок, повільний бренд), але не раніше за вхідний перехід.
  const headlineStart = Math.min(lastStarAt, Math.max(start, readyBy - headlineNeeds));
  // Підпис стартує, коли заходить останнє слово заголовка.
  const subStart = headlineStart + (words - 1) * stagger;

  const starSize = 48 * unit;

  return (
    <AbsoluteFill>
      <Backdrop variant="noise" color={theme.palette.surface} animate />
      <SafeArea style={{ justifyContent: "center", alignItems: "center", gap: 32 * unit }}>
        <div style={{ display: "flex", gap: 12 * unit }}>
          {[0, 1, 2, 3, 4].map((i) => {
            // Пружина до свого старту повертає 0, тож затримка — просто зсув кадру.
            const s = spring({ frame: frame - (start + i * stagger), fps, config: starSpring });
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
        <Headline
          text={headline}
          emphasis={emphasis}
          preset="fade"
          startFrame={headlineStart}
          size="m"
          color={color}
        />
        {sub ? <Body text={sub} preset="fade" startFrame={subStart} size="s" color={color} /> : null}
      </SafeArea>
    </AbsoluteFill>
  );
}
