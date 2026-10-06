import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "audio",
    include: ["test/**/*.test.ts"],
  },
});
