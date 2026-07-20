import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

test("admin can add student by username", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Войти как админ" }).click();
  await expect(page.getByRole("heading", { name: "Ученики" })).toBeVisible();

  await page.getByLabel("Имя ученика").fill("Алия");
  await page.getByLabel("Telegram username или ID").fill("@aliya_geeks");
  await page.locator(".create-form").getByRole("button", { name: "Добавить" }).click();

  await expect(page.locator(".student-row").filter({ hasText: "Алия" })).toBeVisible();
  await expect(page.locator(".student-row").filter({ hasText: "@aliya_geeks" })).toBeVisible();
  await expect(page.locator(".student-card").filter({ hasText: "Алия" })).toBeVisible();
});

test("unknown student sees pending screen", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Войти как ученик" }).click();

  await expect(page.getByText("Заявка отправлена")).toBeVisible();
  await expect(page.getByText("Админ подтвердит вас")).toBeVisible();
});

test("mobile layout has no horizontal overflow", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await page.goto("/");
  await page.getByRole("button", { name: "Войти как админ" }).click();
  await page.getByLabel("Имя ученика").fill("Медер");
  await page.getByLabel("Telegram username или ID").fill("@meder_geeks");
  await page.locator(".create-form").getByRole("button", { name: "Добавить" }).click();

  await expect(page.locator(".student-card").filter({ hasText: "Медер" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await context.close();
});
