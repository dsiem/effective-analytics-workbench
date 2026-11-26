import assert from "node:assert/strict";
import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/metadata", (route) =>
    route.fulfill({
      json: { from: "2016-01-03", to: "2016-02-25", trips: 21932 },
    }),
  );
});

async function openTrips(page: Page, query = "zip=10001") {
  const metadata = page.waitForResponse("**/api/metadata");
  await page.goto(`/trips?${query}`);
  await metadata;
}

for (const timezoneId of ["Europe/Berlin", "America/Los_Angeles"]) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });

    test("applies typed calendar dates without shifting dates and restores them on reload", async ({
      page,
    }) => {
      await openTrips(page);
      const start = page.getByLabel("Pickup start date", { exact: true });
      const end = page.getByLabel("Pickup end date", { exact: true });
      await expect(start).toHaveAttribute("type", "text");
      await expect(end).toHaveAttribute("type", "text");
      await start.fill("2016-01-10");
      await end.fill("2016-02-20");
      await expect(page).toHaveURL(/\/trips\?zip=10001$/);
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(page).toHaveURL(
        /\/trips\?from=2016-01-10&to=2016-02-20&zip=10001$/,
      );
      await page.reload();
      await expect(start).toHaveValue("2016-01-10");
      await expect(end).toHaveValue("2016-02-20");
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(page).toHaveURL(/\/trips$/);
      await expect(start).toHaveValue("");
      await expect(end).toHaveValue("");
      await expect(page.getByLabel("Pickup ZIP code")).toHaveValue("");
    });
  });
}

test("clears dates while preserving the ZIP filter", async ({ page }) => {
  await openTrips(page, "from=2016-01-10&to=2016-01-20&zip=10001");
  await page.getByLabel("Pickup start date").fill("");
  await page.getByLabel("Pickup end date").fill("");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/\/trips\?zip=10001$/);
  await expect(page.getByLabel("Pickup start date")).toHaveValue("");
  await expect(page.getByLabel("Pickup end date")).toHaveValue("");
});

for (const [query, from, to] of [
  ["from=2016-01-10", "2016-01-10", ""],
  ["to=2016-02-20", "", "2016-02-20"],
] as const) {
  test(`preserves an open range: ${query}`, async ({ page }) => {
    await openTrips(page, query);
    await expect(page.getByLabel("Pickup start date")).toHaveValue(from);
    await expect(page.getByLabel("Pickup end date")).toHaveValue(to);
    await expect(
      page.getByRole("button", { name: "Apply", exact: true }),
    ).toBeDisabled();
    await expect(page).toHaveURL(`/trips?${query}`);
  });
}

test("rejects dates outside the dataset bounds before applying filters", async ({
  page,
}) => {
  await openTrips(page);
  await page.getByLabel("Pickup start date").fill("2016-01-02");
  await page.getByLabel("Pickup end date").fill("2016-02-26");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/\/trips\?zip=10001$/);
  await page.getByLabel("Pickup start date").fill("2016-01-03");
  await page.getByLabel("Pickup end date").fill("2016-02-25");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(
    /\/trips\?from=2016-01-03&to=2016-02-25&zip=10001$/,
  );
});

test("keeps date-order validation when dates are entered directly", async ({
  page,
}) => {
  await openTrips(page);
  await page.getByLabel("Pickup start date").fill("2016-02-20");
  await page.getByLabel("Pickup end date").fill("2016-01-10");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL("/trips?zip=10001");
  await expect(
    page.getByRole("heading", { name: "Trip records", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Filters" }).getByRole("alert"),
  ).toContainText("start date must be on or before the end date");
});

test("date fields fit a mobile screen and apply a range", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openTrips(page);
  for (const label of ["Pickup start date", "Pickup end date"]) {
    const input = page.getByLabel(label);
    await expect(input).toBeVisible();
    const bounds = await input.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(360);
  }
  await page.getByLabel("Pickup start date").fill("2016-01-31");
  await page.getByLabel("Pickup end date").fill("2016-02-01");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(
    /\/trips\?from=2016-01-31&to=2016-02-01&zip=10001$/,
  );
});

test("calendars open within the dataset and disable out-of-range dates before selection", async ({
  page,
}) => {
  await openTrips(page);
  const start = page.getByLabel("Pickup start date", { exact: true });
  await expect(start).toHaveValue("");
  const trigger = page.getByRole("button", {
    name: "Choose start date",
    exact: true,
    // Modal calendars hide background controls from the accessibility tree.
    // Keep measuring the same rendered trigger after the dialog opens.
    includeHidden: true,
  });
  // The metadata response precedes rendering the picker in place of its loading button.
  await expect(trigger).toBeEnabled();
  const before = await trigger.boundingBox();
  assert(
    before,
    "Start-date trigger has no layout before opening the calendar",
  );
  const inputBefore = await start.boundingBox();
  assert(
    inputBefore,
    "Start-date input has no layout before opening the calendar",
  );
  await trigger.click();
  const calendar = page.getByRole("dialog", {
    name: "Choose start date",
    exact: true,
  });
  await expect(
    calendar.getByRole("button", {
      name: "Switch to month picker",
      exact: true,
    }),
  ).toHaveText("January 2016");
  const after = await trigger.boundingBox();
  assert(after, "Start-date trigger has no layout after opening the calendar");
  const inputAfter = await start.boundingBox();
  assert(
    inputAfter,
    "Start-date input has no layout after opening the calendar",
  );
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(inputAfter.y).toBeCloseTo(inputBefore.y, 0);
  expect(after.x + after.width).toBeCloseTo(inputAfter.x + inputAfter.width, 0);
  await expect(
    calendar.getByRole("button", { name: "Previous month", exact: true }),
  ).toBeDisabled();
  const disallowed = calendar.getByRole("button", { name: /January 2, 2016/ });
  await expect(disallowed).toBeDisabled();
  const bounds = await disallowed.boundingBox();
  if (!bounds) throw new Error("Missing calendar day");
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(start).toHaveValue("");
  await expect(calendar).toBeVisible();
  await calendar.getByRole("button", { name: /January 3, 2016/ }).click();
  await expect(start).toHaveValue("2016-01-03");
  await expect(calendar).not.toBeVisible();
  await page
    .getByRole("button", { name: "Choose end date", exact: true })
    .click();
  const endCalendar = page.getByRole("dialog", {
    name: "Choose end date",
    exact: true,
  });
  await expect(
    endCalendar.getByRole("button", {
      name: "Switch to month picker",
      exact: true,
    }),
  ).toHaveText("February 2016");
  await expect(
    endCalendar.getByRole("button", { name: /February 26, 2016/ }),
  ).toBeDisabled();
  await expect(
    endCalendar.getByRole("button", { name: "Next month", exact: true }),
  ).toBeDisabled();
});

test("each endpoint constrains the other and the calendar can clear a date", async ({
  page,
}) => {
  await openTrips(page, "from=2016-01-10&to=2016-01-20");
  await page
    .getByRole("button", { name: "Choose start date", exact: true })
    .click();
  const startCalendar = page.getByRole("dialog", {
    name: "Choose start date",
    exact: true,
  });
  await expect(
    startCalendar.getByRole("button", { name: /January 21, 2016/ }),
  ).toBeDisabled();
  await startCalendar
    .getByRole("button", { name: "Clear date", exact: true })
    .click();
  await expect(
    page.getByLabel("Pickup start date", { exact: true }),
  ).toHaveValue("");
  await expect(startCalendar).not.toBeVisible();
  await page
    .getByLabel("Pickup start date", { exact: true })
    .fill("2016-01-10");
  await page
    .getByRole("button", { name: "Choose end date", exact: true })
    .click();
  const endCalendar = page.getByRole("dialog", {
    name: "Choose end date",
    exact: true,
  });
  await expect(
    endCalendar.getByRole("button", { name: /January 9, 2016/ }),
  ).toBeDisabled();
  await expect(
    endCalendar.getByRole("button", { name: /January 10, 2016/ }),
  ).toBeEnabled();
});

test("calendar keyboard navigation cannot cross the earliest allowed date", async ({
  page,
}) => {
  await openTrips(page);
  await page
    .getByRole("button", { name: "Choose start date", exact: true })
    .click();
  const calendar = page.getByRole("dialog", {
    name: "Choose start date",
    exact: true,
  });
  await expect(calendar.getByRole("grid")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Pickup start date", { exact: true }),
  ).toHaveValue("2016-01-03");
  await expect(calendar).not.toBeVisible();
});

test("reopening after typed edits shows a valid date without silently selecting it", async ({
  page,
}) => {
  await openTrips(page);
  const start = page.getByLabel("Pickup start date", { exact: true });
  const end = page.getByLabel("Pickup end date", { exact: true });
  await start.fill("2026-11-15");
  await end.fill("2016-01-20");
  await page
    .getByRole("button", { name: "Choose start date", exact: true })
    .click();
  const calendar = page.getByRole("dialog", {
    name: "Choose start date",
    exact: true,
  });
  await expect(
    calendar.getByRole("button", {
      name: "Switch to month picker",
      exact: true,
    }),
  ).toHaveText("January 2016");
  await expect(
    calendar.getByRole("button", { name: /January 21, 2016/ }),
  ).toBeDisabled();
  await expect(start).toHaveValue("2026-11-15");
  await page.keyboard.press("Escape");
  await expect(calendar).not.toBeVisible();
  await start.fill("");
  await page
    .getByRole("button", { name: "Choose start date", exact: true })
    .click();
  await expect(
    calendar.getByRole("button", {
      name: "Switch to month picker",
      exact: true,
    }),
  ).toHaveText("January 2016");
  await expect(calendar.getByRole("grid")).toBeFocused();
  await expect(calendar.getByRole("grid")).toHaveAttribute(
    "aria-activedescendant",
    /2016-1-3$/,
  );
  await page.keyboard.press("Enter");
  await expect(start).toHaveValue("2016-01-03");
});
