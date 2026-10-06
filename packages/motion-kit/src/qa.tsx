import { type AutoIssueKind, QA_LOG_PREFIX, type QaLogEntry } from "@adc/shared/schemas/qa";
import { createContext, type ReactNode, type RefObject, useContext, useLayoutEffect, useRef } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { contrastRatio, minContrastFor, parseColor, toHex } from "./color.ts";
import { formatInfoFor, isInsideRect, type Rect } from "./format.tsx";

/**
 * QA-режим: компоненти перевіряють себе після рендеру кадру і пишуть у консоль браузера
 * `ADC_QA {json}` (QaLogEntry). Стадія `check` збирає ці рядки через `onBrowserLog`.
 */

export type { QaLogEntry };

/** Пише рядок `ADC_QA {json}` у console. */
export function qaLog(entry: QaLogEntry): void {
  console.log(QA_LOG_PREFIX + JSON.stringify(entry));
}

/** Розбирає рядок логу браузера; не QA-рядок → null. */
export function parseQaLog(text: string): QaLogEntry | null {
  if (!text.startsWith(QA_LOG_PREFIX)) return null;
  try {
    return JSON.parse(text.slice(QA_LOG_PREFIX.length)) as QaLogEntry;
  } catch {
    return null;
  }
}

/** Атрибут, яким компоненти позначають свій фон для перевірки контрасту ("image" — невідомий). */
export const BG_ATTR = "data-adc-bg";

interface QaContextValue {
  enabled: boolean;
  root: RefObject<HTMLDivElement | null>;
}

const QaContext = createContext<QaContextValue>({ enabled: false, root: { current: null } });

/** Вмикає QA-режим для дерева: компоненти пишуть ADC_QA-логи. */
export function QaProvider(props: { enabled: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement | null>(null);
  return (
    <QaContext.Provider value={{ enabled: props.enabled, root }}>
      <AbsoluteFill ref={root}>{props.children}</AbsoluteFill>
    </QaContext.Provider>
  );
}

export function useQaEnabled(): boolean {
  return useContext(QaContext).enabled;
}

/** Прямокутник елемента в координатах композиції (з урахуванням масштабу прев'ю в Studio). */
function rectInComposition(el: Element, root: Element | null, compWidth: number): Rect {
  const r = el.getBoundingClientRect();
  const rr = root?.getBoundingClientRect() ?? { left: 0, top: 0, width: compWidth };
  const scale = rr.width > 0 ? rr.width / compWidth : 1;
  return {
    x: (r.left - rr.left) / scale,
    y: (r.top - rr.top) / scale,
    width: r.width / scale,
    height: r.height / scale,
  };
}

/** Фон під точкою: перший непрозорий шар під елементом. null — невідомо (фото без затемнення). */
export function backgroundAt(el: HTMLElement, x: number, y: number): string | null {
  // Власний фон елемента (плашка, кнопка) має пріоритет.
  const own = el.getAttribute(BG_ATTR);
  if (own) return own === "image" ? null : own;
  const ownBg = parseColor(getComputedStyle(el).backgroundColor);
  if (ownBg && ownBg.a >= 0.85) return toHex(ownBg);
  const doc = el.ownerDocument;
  const stack = doc.elementsFromPoint(x, y);
  for (const candidate of stack) {
    if (candidate === el || el.contains(candidate)) continue;
    const marked = candidate.getAttribute(BG_ATTR);
    if (marked) return marked === "image" ? null : marked;
    const tag = candidate.tagName.toLowerCase();
    if (tag === "img" || tag === "video" || tag === "canvas") return null;
    const bg = parseColor(getComputedStyle(candidate).backgroundColor);
    if (bg && bg.a >= 0.85) return toHex(bg);
  }
  return null;
}

function effectiveOpacity(el: HTMLElement): number {
  let o = 1;
  let cur: HTMLElement | null = el;
  while (cur) {
    const v = Number.parseFloat(getComputedStyle(cur).opacity);
    if (!Number.isNaN(v)) o *= v;
    cur = cur.parentElement;
  }
  return o;
}

export interface QaCheckOptions {
  component: string;
  /** Перевірити, що елемент у safe-зоні. */
  safeArea?: boolean;
  /** Перевірити контраст (колір тексту — computed color елемента). */
  contrast?: boolean;
  /** Додаткові перевірки компонента (переповнення тексту, масштаб фото…). */
  extra?: (
    el: HTMLElement,
    report: (kind: AutoIssueKind, detail: string, value?: number | null) => void,
  ) => void;
}

/**
 * Хук QA-перевірок елемента. Працює лише в QA-режимі, у `useLayoutEffect` після кожного кадру;
 * однаковий запис логується один раз на монтування компонента.
 */
export function useQaCheck(ref: RefObject<HTMLElement | null>, options: QaCheckOptions): void {
  const { enabled, root } = useContext(QaContext);
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const seen = useRef(new Set<string>());

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const report = (kind: AutoIssueKind, detail: string, value: number | null = null) => {
      const key = `${kind}|${detail}`;
      if (seen.current.has(key)) return;
      seen.current.add(key);
      qaLog({ kind, component: options.component, detail, value, frame });
    };
    // Невидимий елемент (ще не з'явився / вже зник) не перевіряємо.
    if (effectiveOpacity(el) < 0.05) return;

    options.extra?.(el, report);

    const rect = rectInComposition(el, root.current, width);
    if (options.safeArea && rect.width > 0 && rect.height > 0) {
      const { safe } = formatInfoFor(width, height);
      if (!isInsideRect(rect, safe)) {
        const r = (n: number) => Math.round(n);
        report(
          "outside_safe_area",
          `елемент ${r(rect.x)},${r(rect.y)} ${r(rect.width)}×${r(rect.height)} виходить за safe-зону ${safe.x},${safe.y} ${safe.width}×${safe.height}`,
          null,
        );
      }
    }

    if (options.contrast) {
      const style = getComputedStyle(el);
      const color = parseColor(style.color);
      const r = el.getBoundingClientRect();
      if (color && color.a > 0.5 && r.width > 0) {
        const bg = backgroundAt(el, r.left + r.width / 2, r.top + r.height / 2);
        if (bg) {
          const fg = toHex(color);
          const ratio = contrastRatio(fg, bg);
          const fontSize = Number.parseFloat(style.fontSize) || 40;
          const min = minContrastFor(fontSize);
          if (ratio < min) {
            report(
              "low_contrast",
              `текст ${fg} на фоні ${bg}: контраст ${ratio.toFixed(2)} < ${min}`,
              Math.round(ratio * 100) / 100,
            );
          }
        }
      }
    }
  });
}
