/**
 * Еталон: типографічна сцена без фото. Великий текст на кольоровому полі, акценти підсвічуються
 * маркером (preset highlight). Декоративне коло з @remotion/shapes (форма, не гліф) розкривається
 * пружиною бренду і далі повільно доростає до кінця сцени, щоб кадр не завмирав після тексту.
 * Та сама пружина, що розкриває коло, саджає текстовий блок на місце — елементи реагують один на одного.
 * Колір поля — перший з primary / secondary / background, на якому читається accent: маркери
 * підсвітки малюються акцентним кольором, а бренд-кіт гарантує його контраст лише з background.
 * Landscape: текст у лівій колонці, коло — за правою половиною кадру.
 * Старти виводяться з довжини сцени, вхідного переходу, кількості слів і темпу бренду.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  contrastRatio,
  defaultStagger,
  easings,
  KineticText,
  progress,
  readableOn,
  SafeArea,
  springFor,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { Circle } from "@remotion/shapes";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit, width, height, isLandscape, safe } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { headline, sub, emphasis } = props.scene.text;
  const d = props.durationInFrames;
  const { palette } = theme;

  // Поле — перший з кольорів бренду, на якому акцент дає ≥ 3:1 (поріг перевірки для великого тексту);
  // background підходить завжди, тож підсвітка ніколи не зливається з фоном.
  const field =
    [palette.primary, palette.secondary, palette.background].find(
      (c) => contrastRatio(palette.accent, c) >= 3,
    ) ?? palette.background;
  // Текст — читабельний на фактичному полі; коло — другим кольором бренду, не тим, що й поле.
  const color = readableOn(field, palette);
  const circleColor = field === palette.secondary ? palette.primary : palette.secondary;

  // Перший біт — не раніше, ніж закінчиться вхідний перехід: вхід під переходом невидимий.
  const start = props.scene.transitionFrames;
  // Усе, що треба прочитати, стоїть на місці приблизно до чверті сцени (перевірки — на 50 % і 90 %).
  const readyBy = Math.round(d * 0.25);
  // Слово в highlight осідає за 18 кадрів після свого старту (маркер доріс, колір перемкнуто).
  const settle = 18;
  const words = headline.split(/\s+/).filter(Boolean).length;
  // Послівний вхід, якщо він встигає; інакше (коротка сцена, довгий заголовок, повільний бренд) — по рядках.
  const wordStagger = defaultStagger(theme.motion, "word");
  const byWord = start + (words - 1) * wordStagger + settle <= readyBy;
  const by = byWord ? "word" : "line";
  const stagger = byWord ? wordStagger : defaultStagger(theme.motion, "line");
  // Підзаголовок стартує, коли починає заходити останній елемент заголовка
  // (кількість рядків відома лише після верстки, тому беремо maxLines).
  const maxLines = 4;
  const subStart = start + (byWord ? words - 1 : maxLines - 1) * stagger;

  // Коло: пружина бренду розкриває його зі старту сцени до ~42 % короткої сторони, а далі воно
  // повільно доростає ще на 8 % аж до останнього кадру — тому кадр рухається і після тексту.
  const open = spring({ frame: frame - start, fps, config: springFor(theme.motion) });
  const drift = progress(frame, start, Math.max(1, d - start), easings.inOut);
  const radius = Math.max(1, Math.min(width, height) * (0.42 * open + 0.08 * drift));
  // Одна пружина у двох місцях: поки коло розкривається, текстовий блок стоїть трохи нижче
  // і разом із ним підтягується на своє місце.
  const lift = (1 - open) * 40 * unit;
  // Центр кола: у vertical і square — центр кадру, у landscape — середина правої половини.
  const cx = isLandscape ? width * 0.72 : width / 2;
  const cy = height / 2;

  // Landscape: текст у лівій колонці (~55 % safe-зони), а не рядком через усю широку смугу.
  const align = isLandscape ? "left" : "center";
  const textWidth = isLandscape ? Math.round(safe.width * 0.55) : undefined;
  const maxFont = Math.round((isLandscape ? 100 : 140) * unit);
  const minFont = Math.round((isLandscape ? 52 : 56) * unit);
  const gap = 32 * unit;

  return (
    <AbsoluteFill>
      <Backdrop variant="solid" color={field} />
      <div style={{ position: "absolute", left: cx - radius, top: cy - radius, opacity: 0.18 }}>
        <Circle radius={radius} fill={circleColor} />
      </div>
      <SafeArea style={{ justifyContent: "center" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap,
            transform: `translateY(${lift}px)`,
          }}
        >
          <KineticText
            text={headline}
            preset="highlight"
            by={by}
            stagger={stagger}
            startFrame={start}
            emphasis={emphasis}
            maxLines={maxLines}
            maxFontSize={maxFont}
            minFontSize={minFont}
            color={color}
            align={align}
            width={textWidth}
          />
          {sub ? (
            <Body
              text={sub}
              preset="rise"
              startFrame={subStart}
              color={color}
              align={align}
              width={textWidth}
            />
          ) : null}
        </div>
      </SafeArea>
    </AbsoluteFill>
  );
}
