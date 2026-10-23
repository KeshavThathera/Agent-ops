import { defineConfig, devices } from "@playwright/test";

// End-to-end UI tests. They run against the dev servers (started automatically if not already running)
// and the seeded demo database (DEMO_ACCOUNTS_ENABLED=true). Each test creates its own workflows.
// Set BASE_URL to test another deployment (e.g. the Render URL); no local servers are started then.
const BASE_URL = process.env.BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: BASE_URL ? undefined : [
    {
      command: process.platform === "win32"
        ? "..\\backend\\.venv\\Scripts\\python.exe -m uvicorn app.main:app --app-dir ../backend --port 8000"
        : "../backend/.venv/bin/python -m uvicorn app.main:app --app-dir ../backend --port 8000",
      url: "http://127.0.0.1:8000/api/health",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    { command: "npm run dev", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 120_000 },
  ],
});
