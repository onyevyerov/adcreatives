import { exampleScenes } from "@adc/motion-kit/examples";

/**
 * Реєстр сцен для Studio (`pnpm --filter @adc/remotion studio`): еталонні сцени
 * motion-kit під id сцен фікстури «Зерно». У рендері задачі аліас `@job/scenes`
 * вказує на `rev/<n>/video/scenes/index.ts`.
 */
const registry = {
  s1: exampleScenes["hook-photo"],
  s2: exampleScenes["offer-price"],
  s3: exampleScenes["cta-logo"],
};

export default registry;
