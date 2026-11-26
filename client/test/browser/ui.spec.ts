import { tripPreviewResponse } from "../trip-fixture";
import { expect, test } from "@playwright/test";

const trip = {
  trip_id: "stable-trip",
  pickup_at: "2016-01-01 10:00:00",
  dropoff_at: "2016-01-01 10:15:00",
  pickup_zip: "10001",
  dropoff_zip: "10019",
  distance: 3,
  fare: 12,
  duration: 15,
};

test("compact Records shows trip details and a sort menu within a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/trip-comment-counts**", (route) =>
    route.fulfill({ json: { [trip.trip_id]: 0 } }),
  );
  await page.route("**/api/trips**", async (route) => {
    const sort = new URL(route.request().url()).searchParams.get("sort");
    if (sort === "fare") await pending;
    return route.fulfill(tripPreviewResponse([trip]));
  });
  await page.goto("/trips");
  const table = page.getByRole("table", {
    name: "Matching trips",
    exact: true,
  });
  await expect(table.getByRole("row").last().getByRole("cell")).toHaveText([
    trip.pickup_at,
    "10001 → 10019",
    trip.dropoff_at,
    "3.00 mi",
    "15.0 min",
    "$12.00",
    "0",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByRole("combobox", { name: "Sort trips" })).toHaveCount(
    0,
  );
  const trigger = page.getByRole("button", { name: /^Sort trips/ });
  await expect(trigger).toHaveAccessibleName(
    "Sort trips, currently Latest pickup",
  );
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: /Latest pickup.*selected/ }),
  ).toBeVisible();
  const bounds = await menu.boundingBox();
  if (!bounds) throw new Error("Sort menu has no visible bounds");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Highest fare" }).click();
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveAccessibleName(
    "Sort trips, currently Highest fare",
  );
  await expect(trigger).toBeFocused();
  finish();
  const inspect = table.getByRole("button", { name: /^Details and comments/ });
  await inspect.click();
  await expect(
    page.getByRole("dialog", { name: "Record details" }),
  ).toBeVisible();
});

test("mobile trip records scroll through the desktop columns with the Comments header pinned", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rows = Array.from({ length: 40 }, (_, index) => ({
    ...trip,
    trip_id: `trip-${index}`,
    duration: index + 15,
  }));
  await page.route("**/api/trips**", (route) =>
    route.fulfill(tripPreviewResponse(rows)),
  );
  await page.goto("/trips");

  const scroll = page.getByRole("region", { name: "Scrollable trip records" });
  const table = scroll.getByRole("table", { name: "Matching trips" });
  const headers = table.getByRole("columnheader");
  const desktopColumns = [
    "Pickup time",
    "Route · ZIP codes",
    "Drop-off time",
    "Distance",
    "Duration",
    "Fare",
    "Comments",
  ];
  await expect(headers).toHaveText(desktopColumns);
  await scroll.scrollIntoViewIfNeeded();
  const comments = table.getByRole("columnheader", { name: "Comments" });
  const shadowCount = () =>
    comments.evaluate(
      (header) => getComputedStyle(header).boxShadow.match(/rgba?\(/g)?.length,
    );
  await expect.poll(shadowCount).toBe(2);
  const initial = await comments.boundingBox();
  if (!initial) throw new Error("No visible trip actions header cell");
  const offsets = await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.scrollLeft = element.scrollWidth;
    return { left: element.scrollLeft, top: element.scrollTop };
  });
  expect(offsets.top).toBeGreaterThan(0);
  expect(offsets.left).toBeGreaterThan(0);
  await expect.poll(shadowCount).toBe(1);

  const pinned = await comments.boundingBox();
  expect(pinned?.y).toBeCloseTo(initial.y, 0);
  expect(pinned?.x).toBeCloseTo(initial.x, 0);
  const duration = table.getByRole("cell", { name: "54.0 min", exact: true });
  await expect(duration).toBeInViewport({ ratio: 1 });
  expect(
    await duration.evaluate((cell) => {
      const { x, y, width, height } = cell.getBoundingClientRect();
      return cell.contains(
        document.elementFromPoint(x + width / 2, y + height / 2),
      );
    }),
  ).toBe(true);
  await scroll.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect.poll(shadowCount).toBe(2);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(headers).toHaveText(desktopColumns);
});

test("reselecting the current mobile sort preserves the list and history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const searches: URLSearchParams[] = [];
  await page.route("**/api/trips**", (route) => {
    searches.push(new URL(route.request().url()).searchParams);
    return route.fulfill(
      tripPreviewResponse(
        Array.from({ length: 30 }, (_, index) => ({
          ...trip,
          trip_id: `trip-${index}`,
        })),
      ),
    );
  });
  await page.goto("/trips?zip=10001&sort=fare");
  await expect(page.getByText("30 trips", { exact: true })).toBeVisible();
  const scroller = page.getByRole("region", {
    name: "Scrollable trip records",
  });
  const scrollTop = await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(0);
  const historyLength = await page.evaluate(() => history.length);
  const trigger = page.getByRole("button", { name: /^Sort trips/ });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Latest pickup",
    /Highest fare.*selected/,
    "Longest distance",
  ]);
  await menu.getByRole("menuitem", { name: /Highest fare.*selected/ }).click();
  await expect(trigger).toBeFocused();
  await expect(menu).toBeHidden();
  await expect(page.getByText("30 trips", { exact: true })).toBeVisible();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(
    scrollTop,
  );
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(searches).toHaveLength(1);
  expect(searches[0]?.get("zip")).toBe("10001");
  expect(searches[0]?.get("sort")).toBe("fare");
});

test("sidebar collapses to icons, keeps filters, persists, and supports the keyboard shortcut", async ({
  page,
}) => {
  await page.goto("/genie?zip=10001");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toBeVisible();
  const expanded = await navigation.boundingBox();
  expect(expanded?.width).toBeGreaterThan(200);

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
