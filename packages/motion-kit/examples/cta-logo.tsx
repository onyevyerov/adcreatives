/**
 * Еталон: фінальний CTA з лого. Лого заходить м'якою пружиною (Logo завжди анімується springs.premium,
 * за будь-якого бренду), і та сама пружина підтягує на місце блок із закликом і кнопкою — елементи
 * реагують один на одного. Заклик — масштабом, підзаголовок (куди йти: сайт, телефон, адреса) — фейдом,
 * кнопка сідає пружиною і далі пульсує сама; градієнт у кольорах бренду повільно дрейфує, тож кадр
 * живий до останнього кадру ролику.
 * Поле градієнта — перший з primary / secondary / background, на якому читається accent: акцентом
 * намальовані кнопка і слова emphasis, а бренд-кіт гарантує контраст акценту лише з background.
 * Колір тексту і варіант лого вибираються від одного кольору — середини градієнта.
 * Landscape: вузька колонка по центру (~60 % safe-зони), щоб локап не розтягувався на всю смугу.
 * Старти виводяться з довжини сцени, вхідного переходу, кількості слів і темпу бренду.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  CTAButton,
  contrastRatio,
  defaultStagger,
  Headline,
  isDark,
  Logo,
  mix,
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
  const { palette } = theme;

  // Поле — перший з кольорів бренду, на якому акцент дає ≥ 3:1; background підходить завжди,
  // тож кнопка і слова emphasis ніколи не зливаються з фоном.
  const field =
    [palette.primary, palette.secondary, palette.background].find(
      (c) => contrastRatio(palette.accent, c) >= 3,
    ) ?? palette.background;
  // Друга точка градієнта — відтінок поля, відсунутий від акценту (темніший чи світліший — що дає
  // акценту більший контраст), тож акцент читається вздовж усього градієнта. Відтінок береться
  // з кольорів тексту палітри, а не з чистого чорного чи білого.
  const deeper = mix(field, palette.textOnLight, 0.3);
  const lighter = mix(field, palette.textOnDark, 0.3);
  const shade =
    contrastRatio(palette.accent, deeper) >= contrastRatio(palette.accent, lighter) ? deeper : lighter;
  // Текст стоїть по центру кадру, де градієнт — середина між точками; перевірка контрасту теж бере
  // середнє точок. Від цього кольору — і колір тексту, і варіант лого (плашка чи текст лого).
  const mid = mix(field, shade, 0.5);
  const dark = isDark(mid);
  const color = readableOn(mid, palette);

  // Перший біт — не раніше, ніж закінчиться вхідний перехід: вхід під переходом невидимий.
  const start = props.scene.transitionFrames;
  // Лого сідає за 29 кадрів після старту (springs.premium), раніше сцена готова не буде. Фінал
  // (розкадровка дає йому від 90 кадрів) збирається до ~45 % сцени — до перевірки на 50 %, —
  // а далі глядач читає адресу і бачить кнопку, що пульсує.
  const readyBy = Math.max(Math.round(d * 0.45), start + 29);
  // Headline іде по словах з дефолтним кроком бренду, тому рахуємо тим самим значенням.
  const stagger = defaultStagger(theme.motion, "word");
  // Скільки кадрів слову треба, щоб осісти після свого старту (preset scale, за довідкою motion-kit).
  const settle = theme.motion === "premium" ? 29 : theme.motion === "calm" ? 20 : 12;
  const words = headline.split(/\s+/).filter(Boolean).length;
  // Заклик стартує разом із лого. Масштабом — якщо встигає осісти; інакше (довгий заголовок,
  // повільний бренд, коротка сцена) — fade, він сідає за 12 кадрів.
  const lastWord = start + (words - 1) * stagger;
  const scales = lastWord + settle <= readyBy;
  const headlineSettled = lastWord + (scales ? settle : 12);
  // Підзаголовок — з останнім словом заголовка.
  const subStart = lastWord;
  // Кнопка — коли заголовок майже осів, але не пізніше, ніж за 12 кадрів до readyBy (springs.snappy
  // сідає за 12), і не раніше кінця переходу. Пульсувати вона почне сама через 18 кадрів після старту.
  const ctaStart = Math.max(start, Math.min(headlineSettled - 6, readyBy - 12));

  // Одна пружина у двох місцях: та сама, що в Logo (springs.premium, той самий старт). Поки лого
  // розкривається, блок під ним стоїть трохи нижче і разом із лого підтягується на своє місце.
  const lift = spring({ frame: frame - start, fps, config: springs.premium });
  const offset = (1 - lift) * 40 * unit;

  // Landscape: вузька колонка по центру, а не рядок через усю смугу 1728 px. По висоті landscape
  // найтісніший (892 px на лого, три рядки заголовка, підзаголовок і кнопку), тому проміжки менші.
  const column = isLandscape ? Math.round(safe.width * 0.6) : safe.width;
  const gap = (isLandscape ? 32 : 48) * unit;

  return (
    <AbsoluteFill>
      <Backdrop variant="gradient" colors={[field, shade]} angle={150} animate />
      <SafeArea style={{ justifyContent: "center", alignItems: "center", gap }}>
        <Logo variant={dark ? "onDark" : "onLight"} startFrame={start} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap,
            width: column,
            transform: `translateY(${offset}px)`,
          }}
        >
          <Headline
            text={headline}
            emphasis={emphasis}
            preset={scales ? "scale" : "fade"}
            startFrame={start}
            size="l"
            color={color}
            width={column}
          />
          {sub ? (
            <Body text={sub} preset="fade" startFrame={subStart} size="m" color={color} width={column} />
          ) : null}
          <CTAButton text={props.brand.cta.text} startFrame={ctaStart} variant="accent" />
        </div>
      </SafeArea>
    </AbsoluteFill>
  );
}
