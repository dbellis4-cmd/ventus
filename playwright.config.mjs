import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3173", channel: "chrome", headless: true },
  webServer: { command: "node tests/browser/start-fixture.mjs", url: "http://127.0.0.1:3173/login", reuseExistingServer: false, timeout: 120_000 },
});
