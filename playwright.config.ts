import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  webServer: {
    command: "npm run dev:renderer --workspace @swpanel/desktop",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120_000
  },
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light"
  },
  projects: [
    {
      name: "chromium",
      testMatch: ["phase1.browser.spec.ts", "phase2.browser.spec.ts", "phase3.browser.spec.ts", "phase4.browser.spec.ts", "phase6.browser.spec.ts", "phase7.browser.spec.ts", "phase8.browser.spec.ts"],
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "electron",
      testMatch: ["electron.smoke.spec.ts"],
      use: { baseURL: "http://127.0.0.1:5173" }
    }
  ]
});
