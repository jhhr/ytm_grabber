import { defineConfig } from "vitest/config";

// The end-to-end suite (B8): the built extension in real Chromium against a mock YouTube Music
// page and lyrics servers. Slow, so `npm test` leaves it out; `npm run test:e2e` builds, then runs
// this. One browser per file and one file at a time.
export default defineConfig({
  test: {
    include: ["test-e2e/**/*.e2e.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
