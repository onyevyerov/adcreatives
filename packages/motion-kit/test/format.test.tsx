import { FORMAT_SIZE, FORMATS } from "@adc/shared/schemas/common";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// useFormat читає розміри з useVideoConfig — підміняємо контекст Remotion.
const config = { width: 1080, height: 1920, fps: 30, durationInFrames: 90 };
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return { ...actual, useVideoConfig: () => config };
});

const { formatFromSize, formatInfoFor, isInsideRect, SafeArea, useFormat } = await import(
  "../src/format.tsx"
);

function Probe() {
  const f = useFormat();
  return <pre>{JSON.stringify(f)}</pre>;
}

const renderProbe = () =>
  JSON.parse(
    renderToStaticMarkup(<Probe />)
      .replace(/^<pre>|<\/pre>$/g, "")
      .replace(/&quot;/g, '"'),
  );

describe("useFormat", () => {
  it.each(FORMATS)("%s: розміри, прапорці, unit", (format) => {
    Object.assign(config, FORMAT_SIZE[format]);
    const info = renderProbe();
    expect(info.format).toBe(format);
    expect({ width: info.width, height: info.height }).toEqual(FORMAT_SIZE[format]);
    expect(info.isVertical).toBe(format === "vertical");
    expect(info.isLandscape).toBe(format === "landscape");
    expect(info.unit).toBe(1);
  });

  it.each(FORMATS)("%s: safe-зона всередині кадру й займає більшу його частину", (format) => {
    const { width, height } = FORMAT_SIZE[format];
    const { safe } = formatInfoFor(width, height);
    expect(isInsideRect(safe, { x: 0, y: 0, width, height }, 0)).toBe(true);
    expect((safe.width * safe.height) / (width * height)).toBeGreaterThan(0.5);
    // Горизонтально симетрично для vertical/square — центрований текст лишається по центру.
    if (format !== "landscape") expect(safe.x * 2 + safe.width).toBe(width);
  });

  it("vertical: великий запас знизу під підпис і кнопки соцмереж", () => {
    const { safe } = formatInfoFor(1080, 1920);
    expect(1920 - (safe.y + safe.height)).toBeGreaterThan(safe.y);
  });

  it("формат за довільними розмірами — за співвідношенням сторін", () => {
    expect(formatFromSize(720, 1280)).toBe("vertical");
    expect(formatFromSize(1280, 720)).toBe("landscape");
    expect(formatFromSize(600, 600)).toBe("square");
    expect(formatInfoFor(540, 960).unit).toBe(0.5);
  });

  it("SafeArea позиціонується за safe-зоною", () => {
    Object.assign(config, FORMAT_SIZE.square);
    const html = renderToStaticMarkup(
      <SafeArea padding={10}>
        <span>x</span>
      </SafeArea>,
    );
    const { safe } = formatInfoFor(1080, 1080);
    expect(html).toContain(`left:${safe.x}px`);
    expect(html).toContain(`width:${safe.width}px`);
    expect(html).toContain("padding:10px");
  });
});

describe("isInsideRect", () => {
  const outer = { x: 100, y: 100, width: 800, height: 800 };
  it("з допуском", () => {
    expect(isInsideRect({ x: 98, y: 100, width: 100, height: 100 }, outer)).toBe(true);
    expect(isInsideRect({ x: 90, y: 100, width: 100, height: 100 }, outer)).toBe(false);
    expect(isInsideRect({ x: 850, y: 100, width: 100, height: 100 }, outer)).toBe(false);
  });
});
