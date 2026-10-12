import { type CSSProperties, Fragment, type ReactNode, useMemo, useRef } from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { readableOn } from "../color.ts";
import { useFormat } from "../format.tsx";
import { defaultStagger, easings, progress, springFor } from "../motion.ts";
import { useQaCheck } from "../qa.tsx";
import { bodyWeight, headingWeight, type Theme, useTheme } from "../theme.tsx";
import { emphasisPhrases, fitText } from "./layout.ts";
import { createMeasurer } from "./measure.ts";

export type TextPreset = "rise" | "fade" | "scale" | "highlight" | "typewriter";
export type TextAlign = "left" | "center" | "right";

/**
 * Внутрішнє (CountUp, InputField): як намалювати символ тексту з індексом `index`, не змінюючи
 * розкладки. `ch` — інший символ на тому ж місці, `hidden` — символ тримає місце, але невидимий,
 * `before`/`after` — вузли нульової ширини поруч (каретка).
 */
export interface Glyph {
  ch?: string;
  hidden?: boolean;
  before?: ReactNode;
  after?: ReactNode;
}

export interface TextBlockProps {
  text: string;
  maxLines: number;
  maxFontSize: number;
  minFontSize: number;
  width?: number;
  font?: "heading" | "body";
  weight?: number;
  color?: string;
  align?: TextAlign;
  style?: CSSProperties;
  emphasis?: string[];
  /** Без preset — статичний текст. */
  preset?: TextPreset;
  by?: "word" | "line";
  startFrame?: number;
  stagger?: number;
  /** Внутрішнє: підміна символів за індексом у `text` (null — символ як є). */
  glyphs?: (index: number) => Glyph | null;
  /** Назва компонента для QA-логів. */
  component: string;
}

const LINE_HEIGHT = { heading: 1.1, body: 1.3 } as const;

/** Символів за секунду для typewriter за характером руху. */
const TYPE_SPEED: Record<Theme["motion"], number> = { energetic: 30, playful: 26, calm: 18, premium: 15 };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Відступи плашки `highlight` від бокса фрази, em. Рядок має висоту lineHeight; плашка
 * виходить нижче нього на 0.1 em (для heading 1.1), щоб виносні («д», «у», «р») не торкались краю,
 * і на 0.1 em ліворуч і праворуч — щоб перша й остання літери не впирались у край.
 */
function platePadding(lineHeight: number): CSSProperties {
  const lead = (lineHeight - 1.1) / 2;
  return {
    left: "-0.1em",
    right: "-0.1em",
    top: `${(0.04 + lead).toFixed(3)}em`,
    bottom: `${(-0.1 + lead).toFixed(3)}em`,
  };
}

/** Слово символ за символом із підмінами `glyphs` (offset — індекс першого символу слова в тексті). */
function renderGlyphs(word: string, offset: number, glyphs: (index: number) => Glyph | null): ReactNode {
  const out: ReactNode[] = [];
  let run = "";
  const flush = () => {
    if (run) out.push(run);
    run = "";
  };
  for (let i = 0; i < word.length; i++) {
    const g = glyphs(offset + i);
    const ch = g?.ch ?? word.charAt(i);
    if (g?.before) {
      flush();
      out.push(<Fragment key={`b${i}`}>{g.before}</Fragment>);
    }
    if (g?.hidden) {
      flush();
      out.push(
        <span key={`h${i}`} style={{ opacity: 0 }}>
          {ch}
        </span>,
      );
    } else run += ch;
    if (g?.after) {
      flush();
      out.push(<Fragment key={`a${i}`}>{g.after}</Fragment>);
    }
  }
  flush();
  return out;
}

/** Внутрішній блок тексту: підбір розміру, перенос, emphasis, кінетика, QA. */
export function TextBlock(props: TextBlockProps) {
  const theme = useTheme();
  const { safe } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef<HTMLDivElement>(null);

  const font = props.font ?? "heading";
  const family = font === "heading" ? theme.fonts.heading : theme.fonts.body;
  const weight = props.weight ?? (font === "heading" ? headingWeight(theme) : bodyWeight(theme));
  const width = props.width ?? safe.width;
  const color = props.color ?? theme.palette.textOnLight;
  const align = props.align ?? "center";
  const start = props.startFrame ?? 0;
  const by = props.by ?? "word";
  const stagger = props.stagger ?? defaultStagger(theme.motion, by);

  const fit = useMemo(
    () =>
      fitText({
        text: props.text,
        maxLines: props.maxLines,
        width,
        maxFontSize: props.maxFontSize,
        minFontSize: props.minFontSize,
        measure: createMeasurer(family, weight),
      }),
    [props.text, props.maxLines, width, props.maxFontSize, props.minFontSize, family, weight],
  );
  const words = useMemo(() => fit.lines.flat(), [fit]);
  // Індекс першого символу кожного слова в тексті (слова йдуть по порядку, розділені пробілами).
  const offsets = useMemo(() => {
    let cursor = 0;
    return words.map((w) => {
      const at = props.text.indexOf(w, cursor);
      cursor = at < 0 ? cursor : at + w.length;
      return Math.max(0, at);
    });
  }, [words, props.text]);
  const phrases = useMemo(() => {
    const ids = emphasisPhrases(words, props.emphasis);
    if (props.preset !== "highlight") return ids;
    // Слова без літер і цифр усередині фрази («75 — грн») належать її плашці.
    for (let i = 1; i < ids.length - 1; i++) {
      if (ids[i] !== null) continue;
      const prev = ids[i - 1];
      if (prev !== null && prev !== undefined && ids.indexOf(prev, i + 1) > i) ids[i] = prev;
    }
    return ids;
  }, [words, props.emphasis, props.preset]);

  useQaCheck(ref, {
    component: props.component,
    safeArea: true,
    contrast: true,
    extra: (el, report) => {
      const short = props.text.length > 40 ? `${props.text.slice(0, 40)}…` : props.text;
      if (fit.overflow) {
        report(
          "text_overflow",
          `«${short}» не влазить у ${props.maxLines} рядк. ширини ${Math.round(width)} px навіть на мінімумі ${fit.fontSize} px`,
          fit.fontSize,
        );
      } else if (el.scrollWidth > el.clientWidth + 2) {
        report(
          "text_overflow",
          `«${short}» ширший за блок: ${el.scrollWidth} > ${el.clientWidth} px`,
          fit.fontSize,
        );
      } else if (fit.hitMin) {
        report("text_min_size", `«${short}» зменшено до мінімуму ${fit.fontSize} px`, fit.fontSize);
      }
    },
  });

  const springConfig = springFor(theme.motion);
  const totalChars = props.text.length;
  const typedChars =
    props.preset === "typewriter"
      ? Math.floor((Math.max(0, frame - start) * TYPE_SPEED[theme.motion]) / fps)
      : totalChars;

  // Слово → його індекс у тексті, елемент анімації (слово або рядок) і фраза emphasis.
  const element = (lineIdx: number, wi: number) => (by === "line" ? lineIdx : wi);
  const highlight = props.preset === "highlight";
  const lineHeight = LINE_HEIGHT[font];

  let wordIndex = 0;
  let charIndex = 0;
  const lines: ReactNode[] = fit.lines.map((line, lineIdx) => {
    const lineStart = wordIndex;
    // Відрізки рядка: окреме слово або фраза emphasis під однією плашкою (highlight).
    const runs: Array<{ from: number; to: number; phrase: number | null }> = [];
    line.forEach((_word, pos) => {
      const id = highlight ? (phrases[lineStart + pos] ?? null) : null;
      const last = runs[runs.length - 1];
      if (id !== null && last && last.phrase === id) last.to = pos;
      else runs.push({ from: pos, to: pos, phrase: id });
    });

    const children: ReactNode[] = [];
    for (const run of runs) {
      const runFirst = frame - start - element(lineIdx, lineStart + run.from) * stagger;
      const runSpan =
        (element(lineIdx, lineStart + run.to) - element(lineIdx, lineStart + run.from)) * stagger;
      // Плашка фрази росте зліва від кадру 6 після появи першого слова, доки не з'явиться останнє.
      const hp = run.phrase === null ? 0 : progress(runFirst, 6, 12 + runSpan, easings.out);
      const runWords = run.to - run.from + 1;
      const nodes: ReactNode[] = [];
      for (let pos = run.from; pos <= run.to; pos++) {
        const word = line[pos] as string;
        const wi = wordIndex++;
        const isEmph = phrases[wi] !== null;
        const local = frame - start - element(lineIdx, wi) * stagger;
        const style: CSSProperties = { display: "inline-block", whiteSpace: "pre" };
        let content: ReactNode = word;

        switch (props.preset) {
          case "rise": {
            const p = spring({ frame: local, fps, config: springConfig });
            style.opacity = clamp01(local / 8);
            style.transform = `translateY(${((1 - p) * 0.6).toFixed(4)}em)`;
            break;
          }
          case "fade":
            style.opacity = progress(local, 0, 12, easings.out);
            break;
          case "scale": {
            const p = spring({ frame: local, fps, config: springConfig });
            style.opacity = clamp01(local / 6);
            style.transform = `scale(${(0.6 + 0.4 * p).toFixed(4)})`;
            break;
          }
          case "highlight":
            style.opacity = progress(local, 0, 8, easings.out);
            break;
          case "typewriter": {
            const visible = Math.max(0, Math.min(word.length, typedChars - charIndex));
            content = (
              <>
                {word.slice(0, visible)}
                <span style={{ opacity: 0 }}>{word.slice(visible)}</span>
              </>
            );
            break;
          }
          default:
            break;
        }
        charIndex += word.length + 1;
        if (props.glyphs) content = renderGlyphs(word, offsets[wi] ?? 0, props.glyphs);

        if (run.phrase !== null) {
          // Слово перефарбовується, коли плашка доросла до його середини.
          const k = pos - run.from;
          if (hp > (k + 0.5) / runWords) style.color = readableOn(theme.palette.accent, theme.palette);
        } else if (isEmph) {
          style.color = theme.palette.accent;
        }

        if (pos > run.from) nodes.push(" ");
        nodes.push(
          // biome-ignore lint/suspicious/noArrayIndexKey: слова можуть повторюватись; позиція в розкладці — стабільний ключ
          <span key={`${lineIdx}-${pos}`} style={style}>
            {content}
          </span>,
        );
      }

      if (run.from > 0) children.push(" ");
      if (run.phrase === null) {
        children.push(...nodes);
        continue;
      }
      // Одна плашка на фразу: обгортка фрази, плашка під усіма її словами разом із пробілами.
      children.push(
        <span
          key={`p${lineStart + run.from}`}
          style={{ display: "inline-block", whiteSpace: "pre", position: "relative", isolation: "isolate" }}
        >
          <span
            data-adc-plate=""
            style={{
              position: "absolute",
              ...platePadding(lineHeight),
              background: theme.palette.accent,
              borderRadius: "0.14em",
              transform: `scaleX(${hp.toFixed(4)})`,
              transformOrigin: "left center",
              zIndex: -1,
            }}
          />
          {nodes}
        </span>,
      );
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: рядки розкладки не переставляються між кадрами
      <div key={lineIdx} style={{ whiteSpace: "nowrap" }}>
        {children}
      </div>
    );
  });

  return (
    <div
      ref={ref}
      style={{
        width,
        fontFamily: family,
        fontWeight: weight,
        fontSize: fit.fontSize,
        lineHeight: LINE_HEIGHT[font],
        color,
        textAlign: align,
        ...(align === "center" ? { marginLeft: "auto", marginRight: "auto" } : {}),
        ...props.style,
      }}
    >
      {lines}
    </div>
  );
}
