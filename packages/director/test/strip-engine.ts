import { writeFile } from "node:fs/promises";
import { makeGradientPng } from "@adc/render/testing";
import type { RenderStillOptions, ScenePreviewProps } from "@adc/shared";
import { type MockEngineOptions, mockEngine } from "./helpers.ts";

const hex = (n: number) => (Math.abs(Math.round(n)) % 256).toString(16).padStart(2, "0");

/** PNG кадру, що відрізняється від сусідніх кадрів стрічки (крок 15) — «сцена рухається». */
export function movingPng(frame: number): Buffer {
  return makeGradientPng(
    54,
    96,
    `#${hex(frame * 3)}${hex(255 - frame * 2)}40`,
    `#20${hex(frame * 5)}${hex(frame)}`,
  );
}

export const sceneIdOf = (o: RenderStillOptions) =>
  o.composition === "ScenePreview" ? (o.inputProps as ScenePreviewProps).sceneId : "main";

export interface MovingEngineOptions extends MockEngineOptions {
  /** Кадр «стоїть»: замість руху — той самий PNG, що й `frozenAt` (напр., сцена стоїть після кадру 30). */
  frozen?: (o: RenderStillOptions) => number | null;
}

/**
 * Мок RenderEngine (з `mockEngine`), що пише різні PNG для різних кадрів: без цього кожна сцена мала б
 * `static_hold`. `frozen(o)` повертає кадр, чий PNG треба записати замість поточного (кадр стоїть).
 */
export function movingEngine(opts: MovingEngineOptions = {}): ReturnType<typeof mockEngine> {
  const engine = mockEngine(opts);
  const render = engine.renderStill.bind(engine);
  engine.renderStill = async (o: RenderStillOptions) => {
    const res = await render(o);
    const frozenAt = opts.frozen?.(o) ?? null;
    await writeFile(o.out, movingPng(frozenAt ?? o.frame));
    return res;
  };
  return engine;
}
