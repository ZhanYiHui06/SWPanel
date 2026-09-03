import { defineConfig } from "@playwright/test";

/**
 * Production Electron tests only: launches the built main process WITHOUT the
 * dedicated development-renderer CLI argument, so the renderer is served by the
 * restricted `app://swpanel` protocol. These tests deliberately have NO
 * `webServer`: they must never depend on the Vite dev server being reachable on
 * port 5173 (and the loadURL-failure test actually relies on that port being
 * free).
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright-production",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-production", open: "never" }]],
  projects: [
    {
      name: "electron-production",
      testMatch: "electron.production.spec.ts"
    }
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light"
  }
});
