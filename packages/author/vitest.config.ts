import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "author",
    include: ["test/**/*.test.ts"],
  },
});
