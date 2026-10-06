import { defineProject } from "vitest/config";

// Наскрізний тест: справжні краулер (Chromium), бандл і рендер Remotion — по одному файлу, великі таймаути.
export default defineProject({
  test: {
    name: "integration",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    pool: "forks",
  },
});
