/**
 * Еталон: оффер із ціною. Перший emphasis (ціна чи знижка) виноситься в плашку і зрізається
 * із заголовка, щоб цифра була на екрані один раз. Заголовок заходить першим, плашка сідає
 * пружиною — це момент сцени, і та сама пружина відсуває текст, звільняючи їй місце.
 * Умова оффера — дрібніше, body-шрифтом. Фон — м'які форми в кольорах бренду.
 * Старти виводяться з довжини сцени, вхідного переходу, кількості слів і темпу бренду.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  defaultStagger,
  Headline,
  Pill,
  readableOn,
  SafeArea,
  springs,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit, isLandscape, safe } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { headline, sub, emphasis } = props.scene.text;
  const d = props.durationInFrames;

  // Плашка — лише коли сцена про оффер, а перший emphasis — коротка цифра (ціна, знижка) із заголовка.
  // Це єдине дозволене редагування текстів: фразу зрізаємо із заголовка разом із тире, двокрапкою
  // чи комою, що лишилися висіти, і передаємо далі решту emphasis. Підзаголовок не чіпаємо.
  // Чи читається заголовок без фрази — вирішуй сам, коли пишеш сцену; тут лише захист від
  // порожнього залишку (заголовок і був самою ціною): тоді плашки нема, а заголовок цілий.
  const first = emphasis[0];
  const lifted =
    props.scene.purpose === "offer" && first !== undefined && /\d/.test(first) && headline.includes(first)
      ? first
      : null;
  const stripped = lifted
    ? headline
        .replace(lifted, "")
        .replace(/\s*[—–:,-]\s*$/, "")
        .replace(/^\s*[—–:,-]\s*/, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
  const badge = lifted && stripped.length > 0 ? lifted : null;
  const title = badge ? stripped : headline;
  const rest = badge ? emphasis.slice(1) : emphasis;

  // Перший біт — не раніше, ніж закінчиться вхідний перехід: вхід під переходом невидимий.
  const start = props.scene.transitionFrames;
  // Усе, що треба прочитати, стоїть на місці приблизно до чверті сцени (перевірки — на 50 % і 90 %).
  const readyBy = Math.round(d * 0.25);
  // Скільки кадрів слову треба, щоб осісти після свого старту (preset rise, за довідкою motion-kit).
  const settle = theme.motion === "premium" ? 29 : theme.motion === "calm" ? 20 : 12;
  const words = title.split(/\s+/).filter(Boolean).length;
  // Headline не має власного stagger — бере дефолт бренду, тому рахуємо тим самим значенням.
  const stagger = defaultStagger(theme.motion, "word");
  const lastWord = start + (words - 1) * stagger;
  // Послівний «rise», якщо встигає осісти; інакше (коротка сцена, повільний бренд) — «fade», він сідає за 12.
  const rises = lastWord + settle <= readyBy;
  const titleSettled = lastWord + (rises ? settle : 12);
  // Момент сцени: плашка сідає, коли заголовок майже осів, але не пізніше, ніж за 12 кадрів до readyBy
  // (springs.snappy сідає за 12), і не раніше кінця переходу.
  const pillStart = Math.max(start, Math.min(titleSettled - 6, readyBy - 12));
  // Підзаголовок — слідом за плашкою (вона непрозора з 4-го кадру), без плашки — з останнім словом.
  const subStart = badge ? pillStart + 4 : lastWord;

  // Одна пружина у двох місцях: вона саджає плашку і вона ж відсуває текст. Плашка стоїть у потоці
  // від початку (невидима), тож поки її нема, текст стоїть вище — там, де стояв би без неї, — а коли
  // вона сідає, з'їжджає на своє місце. Висота плашки l: кегль 60 плюс відступи 2 × 0.32 em.
  const gap = 36 * unit;
  const land = badge ? spring({ frame: frame - pillStart, fps, config: springs.snappy }) : 1;
  const room = (60 * 1.64 * unit + gap) / 2;
  const shift = (land - 1) * room;

  // Landscape: колонка зліва, а не рядок через усю широку смугу; плашка теж до лівого краю.
  const align = isLandscape ? "left" : "center";
  const textWidth = isLandscape ? Math.round(safe.width * 0.55) : undefined;
  // Backdrop shapes доповідає перевірці контрасту свій базовий колір — background.
  const color = readableOn(theme.palette.background, theme.palette);

  return (
    <AbsoluteFill>
      <Backdrop variant="shapes" animate />
      <SafeArea style={{ justifyContent: "center", gap }}>
        {badge ? (
          <Pill
            text={badge}
            startFrame={pillStart}
            variant="accent"
            size="l"
            style={isLandscape ? { alignSelf: "flex-start" } : undefined}
          />
        ) : null}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap,
            transform: `translateY(${shift}px)`,
          }}
        >
          <Headline
            text={title}
            emphasis={rest}
            preset={rises ? "rise" : "fade"}
            startFrame={start}
            size="l"
            color={color}
            align={align}
            width={textWidth}
          />
          {sub ? (
            <Body
              text={sub}
              emphasis={rest}
              preset="fade"
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
