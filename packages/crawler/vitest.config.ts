import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "crawler",
    include: ["test/**/*.test.ts"],
    // Тести з Chromium запускають браузер — їм потрібно більше часу.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
