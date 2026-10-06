import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "director",
    include: ["test/**/*.test.ts"],
    // typecheckScenes будує TS-програму з типами React/Remotion/motion-kit — перший прогін кілька секунд.
    testTimeout: 90_000,
  },
});
