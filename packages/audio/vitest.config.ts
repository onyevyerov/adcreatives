import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "audio",
    include: ["test/**/*.test.ts"],
    // DSP на 15–30 с стерео (мастер, реверб, зведення) — 1–4 с на тест; під навантаженням `pnpm -r test` 5 с мало.
    testTimeout: 20_000,
  },
});
