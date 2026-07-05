import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/rorca-capture/src/**/*.test.ts"],
  },
});
