import path from "node:path";
import { Config } from "@remotion/cli/config";

// Лише для Studio/CLI: `@job/scenes` → еталонні сцени motion-kit.
// Рендер задачі (`@adc/render` bundleJob) задає аліас на сцени ревізії сам.
Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...(config.resolve?.alias as Record<string, string> | undefined),
      "@job/scenes": path.join(process.cwd(), "src", "default-scenes", "index.ts"),
    },
  },
}));
