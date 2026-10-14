/**
 * Еталон motion blur: поле primary висувається (push) на половину кадру, на нього з-за краю кадру
 * за 6 кадрів влітає картка, а над ними по словах піднімається заголовок.
 * `MotionBlur` — лише на швидких рухах і лише на кадрах самого руху: поле (`samples={4}`, ~половина
 * кадру за 8 кадрів) і картка (дефолтні 3 семпли). Заголовок — без blur: його читають, а розмиття
 * тексту, що читається, заборонене. Обгортки змонтовані тільки поки об'єкт летить: кожна множить
 * вартість рендеру свого піддерева на `samples`, і в одному кадрі їх щонайбільше дві.
 * Нічого не з'являється на місці: поле й картка вже рухаються на першому видимому кадрі.
 * Vertical і square: заголовок угорі, поле й картка — знизу; landscape — ліворуч і праворуч.
 * Старти виводяться з вхідного переходу, довжини сцени, кількості слів і темпу бренду.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  ColorField,
  defaultStagger,
  easings,
  Icon,
  KineticText,
  MotionBlur,
  progress,
  readableOn,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit, width, height, isLandscape, safe } = useFormat();
  const frame = useCurrentFrame();
  const { headline, sub, emphasis } = props.scene.text;
  const { palette } = theme;
  const d = props.durationInFrames;

  // Поле стартує одразу після вхідного переходу і проходить половину кадру за 8 кадрів;
  // картка вилітає, коли поле пройшло половину шляху, і сідає за 6 кадрів.
  const start = props.scene.transitionFrames;
  const fieldAt = start;
  const fieldFrames = 8;
  const cardAt = fieldAt + 4;
  const cardFrames = 6;
  // Заголовок — коли картка сіла, але читабельний до ~чверті сцени: (слів − 1) × stagger + 12.
  const readyBy = Math.round(d * 0.25);
  const stagger = defaultStagger(theme.motion, "word");
  const needs = (headline.split(/\s+/).filter(Boolean).length - 1) * stagger + 12;
  const headlineAt = Math.max(start, Math.min(cardAt + cardFrames, readyBy - needs));
  // Blur лише на кадрах руху: до старту й після посадки всі семпли однакові, а вартість та сама.
  const moving = (at: number, frames: number) => frame >= at && frame < at + frames;

  // Половини кадру: текст — на фоні, картка — на полі, що закриває свою половину.
  const gap = 40 * unit;
  const textBox = isLandscape
    ? { left: safe.x, top: safe.y, width: width / 2 - gap / 2 - safe.x, height: safe.height }
    : { left: safe.x, top: safe.y, width: safe.width, height: height / 2 - gap / 2 - safe.y };
  const cardBox = isLandscape
    ? {
        left: width / 2 + gap / 2,
        top: safe.y,
        width: safe.x + safe.width - width / 2 - gap / 2,
        height: safe.height,
      }
    : {
        left: safe.x,
        top: height / 2 + gap / 2,
        width: safe.width,
        height: safe.y + safe.height - height / 2 - gap / 2,
      };

  // Картка летить з-за краю кадру (низ у vertical / square, правий — у landscape) і гальмує в кінці.
  const fly = 1 - progress(frame, cardAt, cardFrames, easings.out);
  const flyFrom = isLandscape ? width - cardBox.left : height - cardBox.top;
  const cardShift = isLandscape ? `translateX(${fly * flyFrom}px)` : `translateY(${fly * flyFrom}px)`;
  const pad = 36 * unit;
  const cardWidth = Math.round(cardBox.width * 0.86);
  const cardText = sub ?? props.scene.items[0]?.text ?? null;

  const field = (
    <ColorField
      mode="push"
      color="primary"
      from={isLandscape ? "right" : "bottom"}
      cover={0.5}
      startFrame={fieldAt}
      duration={fieldFrames}
    />
  );
  const card = (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          ...cardBox,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: cardWidth,
            boxSizing: "border-box",
            padding: pad,
            display: "flex",
            flexDirection: "column",
            gap: 24 * unit,
            background: palette.surface,
            borderRadius: theme.radius.lg * unit,
            boxShadow: `0 ${18 * unit}px ${48 * unit}px rgba(0,0,0,0.18)`,
            transform: cardShift,
          }}
        >
          <Icon name="zap" size={Math.round(72 * unit)} color="accent" />
          {cardText ? (
            <Body
              text={cardText}
              size="m"
              color={readableOn(palette.surface, palette)}
              width={cardWidth - 2 * pad}
              align="left"
            />
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );

  return (
    <AbsoluteFill>
      <Backdrop variant="solid" />
      {moving(fieldAt, fieldFrames) ? <MotionBlur samples={4}>{field}</MotionBlur> : field}
      {moving(cardAt, cardFrames) ? <MotionBlur>{card}</MotionBlur> : card}
      {/* Текст, що читається, — без MotionBlur: рух «rise» повільний і має лишатися чітким. */}
      <div
        style={{
          position: "absolute",
          ...textBox,
          display: "flex",
          alignItems: "center",
          justifyContent: isLandscape ? "flex-start" : "center",
        }}
      >
        <KineticText
          text={headline}
          preset="rise"
          by="word"
          stagger={stagger}
          startFrame={headlineAt}
          emphasis={emphasis}
          maxLines={3}
          maxFontSize={Math.round((isLandscape ? 100 : 128) * unit)}
          minFontSize={Math.round((isLandscape ? 52 : 56) * unit)}
          color={readableOn(palette.background, palette)}
          align={isLandscape ? "left" : "center"}
          width={textBox.width}
        />
      </div>
    </AbsoluteFill>
  );
}
