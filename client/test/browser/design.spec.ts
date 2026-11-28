import { tripDetails, tripPreviewResponse } from "../trip-fixture";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { gpsFixture } from "../gps-fixture";
import type { Overview } from "@dsiem/analytics-shared/overview";
import type { Trip } from "@dsiem/analytics-shared/trips";

// Deliberately offline review data: production continues to use the warehouse.
const daily = Array.from({ length: 31 }, (_, index) => {
  const trips = Math.round(2400 + Math.sin(index * 0.8) * 520 + index * 18);
  return {
    day: `2016-01-${String(index + 1).padStart(2, "0")}`,
    trips,
    revenue: trips * 13.42,
  };
});
const total = daily.reduce((sum, row) => sum + row.trips, 0);
const overview: Overview = {
  summary: {
    trips: total,
    revenue: total * 13.42,
    avg_fare: 13.42,
    avg_distance: 2.8,
    avg_duration: 14.6,
  },
  daily,
  hourly: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    trips: Math.round(
      800 +
        2400 * Math.exp(-((hour - 18) ** 2) / 28) +
        1300 * Math.exp(-((hour - 9) ** 2) / 12),
    ),
    avg_fare: 13.42,
  })),
  zones: [
    "10001",
    "10019",
    "10022",
    "10016",
    "10003",
    "10036",
    "10017",
    "10023",
    "10011",
    "11430",
  ].map((zip, index) => ({
    zip,
    trips: 12400 - index * 1100,
    revenue: (12400 - index * 1100) * 13.42,
    avg_fare: 13.42,
  })),
  queriedAt: "2026-11-14T10:00:00Z",
};
const trips: Trip[] = Array.from({ length: 8 }, (_, index) => ({
  trip_id: `visual-trip-${index}`,
  pickup_at: `2016-01-31 ${String(18 - index).padStart(2, "0")}:24:00`,
  dropoff_at: `2016-01-31 ${String(18 - index).padStart(2, "0")}:42:00`,
  pickup_zip: "10001",
  dropoff_zip: "10019",
  distance: 2.8 + index * 0.3,
  fare: 13.5 + index * 2.5,
  duration: 18,
  details: tripDetails,
}));
const query = "?from=2016-01-01&to=2016-01-31";

async function capture(
  page: Page,
  info: TestInfo,
  name: string,
  fullPage = true,
) {
  if (process.env.CAPTURE_TEST_SCREENSHOTS !== "1") return;
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function fitsViewport(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

// Catch the regression that flattened every button variant into the same box.
async function primaryIsDistinct(page: Page) {
  const primary = page.getByRole("button", { name: "Apply", exact: true });
  const secondary = page.getByRole("button", {
    name: "Saved views",
    exact: true,
  });
  const primaryStyle = await primary.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(primaryStyle.background).not.toBe(
    await secondary.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  );
  expect(primaryStyle.color).not.toBe(primaryStyle.background);
  expect(primaryStyle.height).toBeGreaterThanOrEqual(36);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const { pathname: path, searchParams } = new URL(route.request().url());
    if (path === "/api/trips") return route.fulfill(tripPreviewResponse(trips));
    const data: Record<string, unknown> = {
      "/api/me": { name: "Avery Morgan", email: "avery@example.com" },
      "/api/metadata": { from: "2016-01-01", to: "2016-02-29", trips: total },
      "/api/overview": overview,
      "/api/trip-map": gpsFixture(),
      "/api/trip-details": trips.find(
        (trip) => trip.trip_id === searchParams.get("tripId"),
      ),
      "/api/trip-comment-counts": Object.fromEntries(
        trips.map((trip, index) => [
          trip.trip_id,
          [3, 0, 12, 0, 1, 0, 0, 4][index],
        ]),
      ),
      "/api/saved-views": {
        rows: [
          {
            id: "57b7651d-c553-4fcf-815d-104cc57fd745",
            title: "Midtown evening pickups",
            body: "Review the evening pickup peak and compare fares across the busiest ZIP codes.",
            filters: { from: "2016-01-01", to: "2016-01-31", zip: "10001" },
            version: 1,
            pinned: true,
            created_at: "2026-11-14T10:00:00Z",
            updated_at: "2026-11-14T10:00:00Z",
          },
        ],
        nextCursor: null,
      },
      "/api/trip-comments": {
        rows: [
          {
            id: "c2222511-09bb-4c34-bbbb-699c90e67729",
            trip: trips[0],
            body: "This fare is consistent with the other Midtown trips. Compare it with the evening average before investigating further.",
            author: { name: "Jordan Lee", email: "jordan@example.com" },
            created_at: "2026-11-14T10:00:00Z",
          },
        ],
        nextCursor: null,
      },
    };
    return route.fulfill({
      status: path in data ? 200 : 404,
      json: data[path] ?? { message: "Unmocked visual review request" },
    });
  });
  // Omit network tiles to make review repeatable offline.
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8f5WQAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`populated workspace and overlays in ${colorScheme} at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`/${query}`);
      await expect(
        page.getByRole("table", { name: "Top pickup ZIP codes", exact: true }),
      ).toBeVisible();
      await primaryIsDistinct(page);
      await fitsViewport(page);
      const tickHeights = await page
        .locator(".chart-tick")
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().height),
        );
      expect(tickHeights.every((height) => height >= 8)).toBe(true);
      const metrics = page.locator(".metrics > .card");
      await expect(metrics).toHaveCount(4);
      const bounds = await metrics.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().y),
      );
      expect(new Set(bounds).size).toBe(width === 390 ? 2 : 1);
      await capture(page, info, "overview");
      if (width === 390) {
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
      }
      await page
        .getByRole("button", { name: "Theme: System", exact: true })
        .click();
      await expect(page.getByRole("menu")).toBeFocused();
      await fitsViewport(page);
      await capture(page, info, "theme-menu", false);
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Theme: System", exact: true }),
      ).toBeFocused();
      if (width === 390) {
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("dialog", { name: "Sidebar", exact: true }),
        ).not.toBeVisible();
      }
      await page
        .locator("header")
        .getByRole("button", { name: "Ask Genie", exact: true })
        .click();
      const helper = page.getByRole("dialog", { name: "Genie", exact: true });
      await expect(
        helper.getByRole("button", {
          name: "Explain the main patterns in this view.",
          exact: true,
        }),
      ).toBeVisible();
      await capture(page, info, "genie-helper", false);
      await helper
        .getByRole("button", { name: "Close Genie", exact: true })
        .click();
      await page.goto(`/trips${query}`);
      const table = page.getByRole("table", {
        name: "Matching trips",
        exact: true,
      });
      await expect(table.getByRole("row")).toHaveCount(9);
      await fitsViewport(page);
      await expect(
        page.getByRole("button", { name: /^Ask Genie/ }),
      ).toHaveCount(1);
      await capture(page, info, "trips");
      await page
        .getByRole("button", { name: "Ask Genie", exact: true })
        .click();
      await expect(
        helper.getByRole("button", {
          name: "Summarize the visible trips and point out unusual fares or distances.",
          exact: true,
        }),
      ).toBeVisible();
      await helper
        .getByRole("button", { name: "Close Genie", exact: true })
        .click();
      await table
        .getByRole("button", { name: /^Details and comments for trip/ })
        .first()
        .click();
      const inspector = page.getByRole("dialog", {
        name: "Record details",
        exact: true,
      });
      await expect(
        inspector.getByText("Jordan Lee", { exact: true }),
      ).toBeVisible();
      const sheet = await inspector.locator(".sheet").boundingBox();
      expect(
        Math.abs((sheet?.x ?? 0) + (sheet?.width ?? 0) - width),
      ).toBeLessThan(20);
      await capture(page, info, "trip-inspector", false);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Saved views", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Open saved view for Midtown evening pickups",
          exact: true,
        }),
      ).toBeVisible();
      await capture(page, info, "saved-views", false);
      await page
        .getByRole("button", { name: "Save this view", exact: true })
        .click();
      const editor = page.getByRole("dialog", {
        name: "What would you call this view?",
        exact: true,
      });
      await editor
        .getByRole("textbox", { name: "View name", exact: true })
        .fill("January fare review");
      await capture(page, info, "save-view", false);
      await page.goto(`/trip-map${query}`);
      const map = page.locator(".map-panel");
      await expect(map).toHaveAttribute("data-gps-ready", "true");
      // The map mount must keep the panel's responsive height.
      expect((await map.boundingBox())?.height).toBeGreaterThanOrEqual(350);
      await expect(
        map.getByRole("button", { name: "Zoom in", exact: true }),
      ).toHaveCSS(
        "background-color",
        colorScheme === "dark" ? "rgb(28, 40, 36)" : "rgb(255, 255, 255)",
      );
      await fitsViewport(page);
      await capture(page, info, "pickup-map");
      await page.goto(`/genie${query}`);
      await expect(
        page.getByRole("heading", { name: "What caught your eye?" }),
      ).toBeVisible();
      await fitsViewport(page);
      await capture(page, info, "genie-page");
      expect(errors).toEqual([]);
    });
  }
}

test("loading, empty, and error states retain the workspace layout", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/overview**", async (route) => {
    await pending;
    await route.fulfill({
      json: {
        ...overview,
        summary: { ...overview.summary, trips: 0 },
        daily: [],
        hourly: [],
        zones: [],
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "Loading" }),
  ).toBeVisible();
  await capture(page, info, "loading");
  release();
  await expect(
    page.getByText(
      "No pickups here. Try another ZIP code or a wider date range.",
    ),
  ).toBeVisible();
  await capture(page, info, "empty");
  await page.route("**/api/trips**", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "warehouse_unavailable",
          message:
            "The warehouse is temporarily unavailable. Try again shortly.",
        },
      },
    }),
  );
  await page.goto("/trips");
  await expect(page.getByRole("alert")).toHaveText(
    "The warehouse is temporarily unavailable. Try again shortly.",
  );
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await capture(page, info, "error");
});

test.describe("compact record layouts", () => {
  test.use({ hasTouch: true });
  for (const width of [320, 390, 768, 1024]) {
    test(`dates and leading record columns are readable at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/trips${query}`);
      const table = page.getByRole("table", { name: "Matching trips" });
      await expect(table.getByRole("row")).toHaveCount(9);

      for (const input of await page.locator(".date-input").all()) {
        const { available, required } = await input.evaluate(
          (node: HTMLInputElement) => {
            const style = getComputedStyle(node);
            const sample = document.createElement("span");
            Object.assign(sample.style, {
              position: "absolute",
              visibility: "hidden",
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              fontVariantNumeric: style.fontVariantNumeric,
            });
            sample.textContent = node.value;
            document.body.append(sample);
            const required = sample.getBoundingClientRect().width;
            sample.remove();
            const available =
              node.getBoundingClientRect().width -
              parseFloat(style.borderLeftWidth) -
              parseFloat(style.borderRightWidth) -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight);
            return { available, required };
          },
        );
        expect(required).toBeLessThanOrEqual(available);
      }

      const row = table.getByRole("row").nth(1);
      const lastVisibleValue = row.getByRole("cell").nth(width >= 1024 ? 5 : 1);
      const textRight = await lastVisibleValue.evaluate((cell) => {
        const text = document.createRange();
        text.selectNodeContents(cell);
        return text.getBoundingClientRect().right;
      });
      const actions = await row.getByRole("cell").last().boundingBox();
      if (!actions) throw new Error("Missing pinned record actions");
      expect(textRight).toBeLessThanOrEqual(actions.x);
      await fitsViewport(page);
    });
  }
});
