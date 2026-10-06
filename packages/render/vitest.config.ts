import { defineProject } from "vitest/config";

// Повільні тести: справжній бандл і Chrome Headless Shell. Один файл за раз, великі таймаути.
export default defineProject({
  test: {
    name: "render",
    include: ["test/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    pool: "forks",
  },
});
