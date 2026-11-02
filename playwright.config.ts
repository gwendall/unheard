import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the real page in a real Chromium: fake microphone playing a fixture, flight
// data replayed in step with it. Point BASE_URL at a server (machine serve for a dev one, or a
// deploy): BASE_URL=http://localhost:4103 pnpm e2e
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 180_000,
  globalTimeout: 600_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
