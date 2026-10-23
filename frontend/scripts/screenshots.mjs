// Captures screenshots of key pages for visual review: node scripts/screenshots.mjs [outDir] [width]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const out = process.argv[2] ?? "screenshots";
const width = Number(process.argv[3] ?? 1440);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
async function as(email) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.request.post(`${BASE}/api/auth/demo-login`, { data: { email }, headers: { "X-Requested-With": "agentops-desk" } });
  return { ctx, page };
}
async function shot(page, path, name, wait = 1500) {
  await page.goto(`${BASE}${path}`);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log("saved", name);
}

const eng = await as("sana.khan@agentops.demo");
const wfs = await (await eng.page.request.get(`${BASE}/api/workflows?origin=seed&page_size=20`)).json();
const completed = wfs.items.find((w) => w.status === "completed");
await shot(eng.page, "/", "dashboard");
await shot(eng.page, `/workflows/${completed.id}`, "workflow-detail", 2500);
await shot(eng.page, "/approvals", "approvals");
await shot(eng.page, "/tickets", "tickets");
await eng.ctx.close();

const admin = await as("neha.joshi@agentops.demo");
await shot(admin.page, "/knowledge", "knowledge");
await shot(admin.page, "/tools", "tools");
await shot(admin.page, "/evaluation", "evaluation");
await shot(admin.page, "/settings", "settings");
await shot(admin.page, "/audit", "audit");
await shot(admin.page, "/about", "about");
await admin.ctx.close();

const emp = await as("riya.mehta@agentops.demo");
await shot(emp.page, "/support?new=1", "support-new");
const mine = await (await emp.page.request.get(`${BASE}/api/workflows?mine=true`)).json();
await shot(emp.page, `/support?wf=${mine.items[0].id}`, "support-conversation", 2500);
await emp.ctx.close();
await browser.close();
