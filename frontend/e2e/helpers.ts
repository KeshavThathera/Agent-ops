import { expect, type Page } from "@playwright/test";

export const RIYA = "riya.mehta@agentops.demo";
export const SANA = "sana.khan@agentops.demo";

/** Uses the labelled demo-account sign-in on the login page (a real server-side session). */
export async function signIn(page: Page, name: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("button", { name: new RegExp(`Account menu for ${name}`) })).toBeVisible();
}

export async function submitRequest(page: Page, text: string): Promise<string> {
  await page.goto("/support?new=1");
  await page.getByLabel("What's the problem?").fill(text);
  await page.getByRole("button", { name: "Submit request" }).click();
  await page.waitForURL(/\/support\?wf=wf_/);
  return new URL(page.url()).searchParams.get("wf")!;
}
