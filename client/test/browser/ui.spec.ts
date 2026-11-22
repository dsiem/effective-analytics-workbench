import { tripDetails } from "../trip-fixture";
import { expect, test } from "@playwright/test";

test("wide trip tables scroll within a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/trips**", (route) =>
    route.fulfill({
      json: {
        rows: [
          {
            trip_id: "stable-trip",
            pickup_at: "2016-01-01 10:00:00",
            dropoff_at: "2016-01-01 10:15:00",
            pickup_zip: "10001",
            dropoff_zip: "10019",
            distance: 3,
            fare: 12,
            duration: 15,
            details: tripDetails,
          },
        ],
        total: 1,
        pageSize: 25,
        nextCursor: null,
      },
    }),
  );
  await page.goto("/trips");
  const table = page.getByRole("table", {
    name: "Matching trips",
    exact: true,
  });
  await expect(table.getByRole("row")).toHaveCount(2);
  const scroll = table.locator("..");
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await scroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const inspect = table.getByRole("button", { name: /^Details and comments/ });
  await expect(inspect).toBeInViewport();
  await inspect.click();
  await expect(
    page.getByRole("dialog", { name: "Record details" }),
  ).toBeVisible();
});

test("sidebar collapses to icons, keeps filters, persists, and supports the keyboard shortcut", async ({
  page,
}) => {
  await page.goto("/genie?zip=10001");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toBeVisible();
  const expanded = await navigation.boundingBox();
  expect(expanded?.width).toBeGreaterThan(200);
  await page.screenshot({
    path: "test-results/foldkit-desktop.png",
    fullPage: true,
    animations: "disabled",
  });

  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await navigation.boundingBox())?.width)
    .toBeLessThan(65);
  const trips = page.getByRole("link", {
    name: "Trip explorer",
    exact: true,
  });
  await trips.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Trip explorer");
  await page.screenshot({
    path: "test-results/foldkit-collapsed.png",
    fullPage: true,
    animations: "disabled",
  });
  await trips.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Trip explorer");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(trips).toBeFocused();
  await trips.click();
  await expect(page).toHaveURL(/\/trips\?zip=10001$/);
  await expect(trips).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toBeVisible();

  await page.keyboard.press("ControlOrMeta+b");
  await expect(
    page.getByRole("button", { name: "Collapse sidebar", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await navigation.boundingBox())?.width)
    .toBeGreaterThan(200);
});

test("mobile sidebar traps focus, closes on navigation and Escape, and leaves desktop preference intact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/genie?zip=10001");
  const trigger = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Sidebar", exact: true });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() =>
      drawer.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.screenshot({
    path: "test-results/foldkit-mobile-sidebar.png",
    fullPage: true,
    animations: "disabled",
  });

  await drawer.getByRole("link", { name: "Trip map", exact: true }).click();
  await expect(page).toHaveURL(/\/trip-map\?zip=10001$/);
  await expect(drawer).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Trip hotspots", exact: true }),
  ).toBeVisible();
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .getByRole("button", { name: "Close navigation", exact: true })
    .last()
    .click();
  await expect(drawer).not.toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    page.getByRole("button", { name: "Collapse sidebar", exact: true }),
  ).toBeVisible();
});

test("saved view dialog has labelled fields, keyboard dismissal, and restores focus", async ({
  page,
}) => {
  await page.goto("/trips?zip=10001");
  const trigger = page.getByRole("button", {
    name: "Save view",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "What would you call this view?",
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", { name: "View name", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Save view", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Test draft");
  await expect(
    dialog.getByRole("button", { name: "Save view", exact: true }),
  ).toBeEnabled();
  await expect(dialog).toContainText("ZIP 10001");
  await page.screenshot({
    path: "test-results/foldkit-saved-view-dialog.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

for (const width of [360, 390, 768, 1024, 1440]) {
  test(`workspace fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/trips");
    await expect(
      page.getByRole("heading", { name: "Trip records", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Apply", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/foldkit-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
}

test("sidebar shows the proxy user and keeps the profile available when collapsed", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({
    "X-Forwarded-Preferred-Username": "Avery Morgan",
    "X-Forwarded-Email": "avery@example.com",
    "X-Forwarded-User": "viewer-1",
  });
  await page.goto("/genie");
  const profile = page.getByLabel("Signed in as Avery Morgan", { exact: true });
  await expect(
    profile.getByText("Avery Morgan", { exact: true }),
  ).toBeVisible();
  await expect(
    profile.getByText("avery@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("header").getByText("Databricks", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Databricks sample data", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/sidebar-current-user.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(profile.getByText("AM", { exact: true })).toBeVisible();
  await profile.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Avery Morgan · avery@example.com",
  );
});

test("sidebar omits the optional profile when no user identity is available", async ({
  page,
}) => {
  await page.route("**/api/me", (route) => route.fulfill({ json: null }));
  const response = page.waitForResponse("**/api/me");
  await page.goto("/genie");
  await response;
  await expect(page.getByLabel(/^Signed in as /)).toHaveCount(0);
  await expect(
    page.getByText("Databricks sample data", { exact: true }),
  ).toHaveCount(0);
});
