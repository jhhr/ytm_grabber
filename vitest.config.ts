import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only; the slow Chromium end-to-end suite (B8) gets its own command.
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
