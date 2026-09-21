import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const testRoot = mkdtempSync(join(tmpdir(), "pa-browser-"));

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4318",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command:
      "pnpm exec tsx scripts/setup.ts && pnpm exec vite build && pnpm exec tsx tests/serve-e2e.ts",
    url: "http://127.0.0.1:4318/api/settings",
    reuseExistingServer: false,
    env: {
      PA_PORT: "4318",
      PA_DATA_DIR: join(testRoot, "data"),
      PA_PROFILE_DIR: join(testRoot, "profile"),
      PA_TIMEZONE: "Europe/Berlin",
      OPENAI_API_KEY: "test-key",
      PA_MODEL: "",
      PA_MODEL_BASE_URL: "http://127.0.0.1:4320/v1",
      PA_KEY_FILE: "",
    },
    timeout: 60000,
  },
});
