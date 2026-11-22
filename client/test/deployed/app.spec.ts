import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { Schema } from "effect";
import { SavedViewsPage } from "../../../shared/saved-views";

const pickupDate = process.env.DATABRICKS_APP_TEST_DATE ?? "2016-01-15";
const date = new URLSearchParams({
  from: pickupDate,
  to: pickupDate,
}).toString();
const pickupZip = "10001";
const filters = `${date}&zip=${pickupZip}`;
const warehouseTimeout = 130_000;

async function openApp(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(
    page,
    "Sign in again if your Databricks browser session expired",
  ).toHaveURL(path, { timeout: 5_000 });
  await expect(
    page.getByLabel(/^Signed in as /),
    "Databricks should forward the signed-in viewer to the app",
  ).toBeVisible();
}

test("filters and pages live trip records and opens their source details", async ({
  page,
}) => {
  await openApp(page, `/trips?${date}`);
  await page.getByLabel("Pickup ZIP code").fill(pickupZip);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(`/trips?${filters}`);

  const table = page.getByRole("table", {
    name: "Matching trips",
    exact: true,
  });
  const routes = table.getByRole("cell", { name: /^10001 → / });
  await expect(routes.first()).toBeVisible({ timeout: warehouseTimeout });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible({
    timeout: warehouseTimeout,
  });
  await expect(routes.first()).toBeVisible();
  expect(await routes.count()).toBe((await table.getByRole("row").count()) - 1);

  await table
    .getByRole("button", { name: /^Details and comments for trip/ })
    .first()
    .click();
  const details = page.getByRole("dialog", {
    name: "Record details",
    exact: true,
  });
  await details.getByText("Source details", { exact: true }).click();
  await expect(
    details.getByText(/^yellow_tripdata_\d{4}-(0[1-9]|1[0-2])\.csv\.gz$/),
  ).toBeVisible();
});

test("loads live pickup and drop-off hotspots", async ({ page }) => {
  await openApp(page, `/trip-map?${filters}`);
  await expect(
    page.getByRole("button", { name: /^Area 1, .+ pickups$/ }),
  ).toBeVisible({
    timeout: warehouseTimeout,
  });
  const dropoffs = page.getByRole("tab", { name: "Drop-offs", exact: true });
  await dropoffs.click();
  await expect(dropoffs).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: /^Area 1, .+ drop-offs$/ }),
  ).toBeVisible({
    timeout: warehouseTimeout,
  });
});

test("reopens a saved view after a full reload", async ({ page }) => {
  await openApp(page, `/trips?${filters}`);
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "What would you call this view?",
    exact: true,
  });
  const title = `Browser E2E ${randomUUID()}`;
  await editor.getByLabel("View name", { exact: true }).fill(title);

  try {
    await editor
      .getByRole("button", { name: "Save view", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await page.goto(`/trips?${date}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Pickup ZIP code")).toHaveValue("");
    await page
      .getByRole("button", { name: "Saved views", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Saved views",
      exact: true,
    });
    await picker
      .getByRole("searchbox", { name: "Search all saved views" })
      .fill(title);
    await picker
      .getByRole("button", {
        name: `Open saved view for ${title}`,
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(`/trips?${filters}`);
    await expect(page.getByLabel("Pickup ZIP code")).toHaveValue(pickupZip);
  } finally {
    await test.step("Clean up the temporary saved view", async () => {
      const lookup = await page.request.get("/api/saved-views", {
        params: { q: title },
        maxRedirects: 0,
        timeout: 15_000,
      });
      expect(lookup.status(), "Find the temporary saved view").toBe(200);
      const { rows } = Schema.decodeUnknownSync(SavedViewsPage)(
        await lookup.json(),
      );
      const saved = rows.find((row) => row.title === title);
      if (saved) {
        const deletion = await page.request.delete(
          `/api/saved-views/${saved.id}`,
          {
            params: { version: saved.version },
            maxRedirects: 0,
            timeout: 15_000,
          },
        );
        expect(deletion.status(), "Delete the temporary saved view").toBe(200);
      }
    });
  }
});
