import { defineConfig } from "vitest/config";

// Кореневий запуск `vitest` бачить кожен пакет як окремий проєкт.
// Пакети без власного vitest.config.ts пропускаються.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts", "tests/*/vitest.config.ts"],
  },
});
