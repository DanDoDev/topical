import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:43111",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node test/support/ui-test-server.js",
    url: "http://127.0.0.1:43111/api/v1/bootstrap",
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 1_000 }
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
