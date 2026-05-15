import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/rorca-pi-extension/extensions/rorca/__tests__/**/*.test.ts"],
  },
});
