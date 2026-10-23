// Runs a demo evaluation through the API and captures the evaluation, support and tools pages.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const out = process.argv[2] ?? "screenshots";
const H = { "X-Requested-With": "agentops-desk" };
const browser = await chromium.launch();

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.request.post(`${BASE}/api/auth/demo-login`, { data: { email: "neha.joshi@agentops.demo" }, headers: H });
const run = await (await page.request.post(`${BASE}/api/evaluations/runs`, { data: { mode: "demo" }, headers: H })).json();
for (let i = 0; i < 120; i++) {
  const r = await (await page.request.get(`${BASE}/api/evaluations/runs/${run.id}`)).json();
  if (r.run.status === "completed" || r.run.status === "failed") { console.log("eval", r.run.status, JSON.stringify(r.run.summary.agent?.task_completion_rate)); break; }
  await page.waitForTimeout(1000);
}
await page.goto(`${BASE}/evaluation`);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/evaluation-run.png`, fullPage: true });
await page.goto(`${BASE}/tools`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/tools-2.png`, fullPage: false });

await page.request.post(`${BASE}/api/auth/demo-login`, { data: { email: "riya.mehta@agentops.demo" }, headers: H });
const mine = await (await page.request.get(`${BASE}/api/workflows?mine=true`)).json();
await page.goto(`${BASE}/support?wf=${mine.items[0].id}`);
await page.waitForTimeout(2500);
console.log("support overflow px:", await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
await page.screenshot({ path: `${out}/support-2.png`, fullPage: false });
await browser.close();
