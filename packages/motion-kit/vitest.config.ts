import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "motion-kit",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
