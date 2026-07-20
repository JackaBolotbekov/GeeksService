import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

test("admin can add student, score lessons and update leaderboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Geeks Service" })).toBeVisible();
  await page.getByRole("button", { name: "Войти как админ" }).click();
  await expect(page.getByText("Оценки и ученики")).toBeVisible();

  await page.getByLabel("Имя ученика").fill("Алия");
  await page.getByLabel("Telegram ID").fill("7001");
  await page.getByRole("button", { name: "Добавить" }).click();
  await expect(page.locator(".student-card").filter({ hasText: "Алия" })).toBeVisible();

  await page.locator(".score-row").filter({ hasText: "Алия" }).locator(".lesson-grid button").nth(0).click();
  await page.locator(".score-picker").getByRole("button", { name: "10" }).click();
  await expect(page.locator(".student-card").filter({ hasText: "Алия" }).getByText("10").first()).toBeVisible();

  await page.locator(".score-row").filter({ hasText: "Алия" }).locator(".lesson-grid button").nth(1).click();
  await page.locator(".score-picker").getByRole("button", { name: "9" }).click();
  await expect(page.locator(".student-card").filter({ hasText: "Алия" }).getByText("19").first()).toBeVisible();
  await expect(page.locator(".student-card").filter({ hasText: "Алия" }).getByText("2/12 домашек")).toBeVisible();
});

test("unknown student sees pending screen", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Войти как ученик" }).click();

  await expect(page.getByText("Заявка отправлена")).toBeVisible();
  await expect(page.getByText("Админ добавит вас в группу")).toBeVisible();
});

test("mobile layout has no horizontal overflow", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await page.goto("/");
  await page.getByRole("button", { name: "Войти как админ" }).click();
  await page.getByLabel("Имя ученика").fill("Медер");
  await page.locator(".create-form").getByRole("button", { name: "Добавить" }).click();

  await expect(page.locator(".student-card").filter({ hasText: "Медер" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await context.close();
});
