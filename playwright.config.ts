import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the real page in a real Chromium: fake microphone playing a fixture, flight
// data replayed in step with it. Point BASE_URL at a server (machine serve for a dev one, or a
// deploy): BASE_URL=http://localhost:4103 pnpm e2e
//
// The cleaned video needs browsers with real codecs (Playwright's own Chromium has no AAC or H.264):
// the system's Chrome, and Firefox and WebKit on demand. E2E_VIDEO_BROWSERS=1 adds those two; where
// Firefox cannot make a profile in its usual place, E2E_FIREFOX_HOME gives it a home of its own.
const VIDEO = /check-video/;
const videoIn = (name: string, use: object) => ({ name, testMatch: VIDEO, use: { viewport: { width: 1440, height: 900 }, ...use } });
const FIREFOX_HOME = process.env.E2E_FIREFOX_HOME;

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
  projects: [
    { name: "chromium", testIgnore: VIDEO, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    videoIn("chrome", { ...devices["Desktop Chrome"], channel: "chrome" }),
    ...(process.env.E2E_VIDEO_BROWSERS
      ? [
          videoIn("firefox", { ...devices["Desktop Firefox"], launchOptions: FIREFOX_HOME ? { env: { ...process.env, HOME: FIREFOX_HOME, CFFIXED_USER_HOME: FIREFOX_HOME } } : {} }),
          videoIn("webkit", devices["Desktop Safari"]),
        ]
      : []),
  ],
});
