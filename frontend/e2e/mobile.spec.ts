import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("core pages are usable on a phone without horizontal scrolling", async ({ page }) => {
  await signIn(page, "Sana Khan");
  for (const path of ["/", "/support?new=1", "/tickets", "/approvals", "/knowledge", "/workflows"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
  await page.getByRole("button", { name: "Open navigation" }).click();
  const nav = page.getByRole("dialog", { name: "Navigation" });
  await expect(nav).toBeVisible();
  await nav.getByRole("link", { name: "Tickets" }).click();
  await expect(page).toHaveURL(/\/tickets$/);
  await expect(page.getByText("Demo mode — simulated AI and IT tools").filter({ visible: true })).toBeVisible();
});
