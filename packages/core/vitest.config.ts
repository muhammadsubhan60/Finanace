import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "text"],
      // M2 gate: the profit engine must be fully branch-covered.
      thresholds: { "src/engine/**": { branches: 100, functions: 100, lines: 100, statements: 100 } },
    },
  },
});
