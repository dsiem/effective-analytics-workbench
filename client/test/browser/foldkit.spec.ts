import { expect, test } from "@playwright/test";
import { Schema } from "effect";
import { TripSearch, type TripCursor } from "../../../shared/trips";
import { tripCursorFor } from "../trip-fixture";

const overview = {
  summary: {
    trips: 50,
    revenue: 600,
    avg_fare: 12,
    avg_distance: 3,
    avg_duration: 15,
  },
  daily: [
    { day: "2016-01-01", trips: 20, revenue: 200 },
    { day: "2016-01-02", trips: 30, revenue: 400 },
  ],
  hourly: [
    { hour: 8, trips: 20, avg_fare: 10 },
    { hour: 18, trips: 30, avg_fare: 13.33 },
  ],
  zones: [{ zip: "10001", trips: 50, revenue: 600, avg_fare: 12 }],
  queriedAt: "2026-11-14T10:00:00Z",
};
const trip = {
  trip_id: "stable-trip",
  pickup_at: "2016-01-01 10:00:00",
  dropoff_at: "2016-01-01 10:15:00",
  pickup_zip: "10001",
  dropoff_zip: "10019",
  distance: 3,
  fare: 12,
  duration: 15,
  details: {
    source_file: "yellow_tripdata_2016-01.csv.gz",
    vendor_id: 2,
    passenger_count: 1,
    rate_code_id: 1,
    store_and_fwd_flag: "N",
    payment_type: 2,
    pickup_location: { longitude: -73.99, latitude: 40.75 },
    dropoff_location: { longitude: -73.98, latitude: 40.76 },
    tip_amount: 0,
    tolls_amount: 2.5,
    extra: 0.5,
    mta_tax: 0.5,
    improvement_surcharge: 0.3,
    total_amount: 15.8,
  },
};

test("overview charts, navigation, paging, and browser history work through the runtime", async ({
  page,
}) => {
  await page.route("**/api/overview**", (route) =>
    route.fulfill({ json: overview }),
  );
  const filters = { zip: "10001" };
  const middle = { ...trip, trip_id: "middle", fare: 18 };
  const last = { ...trip, trip_id: "last", fare: 24 };
  const firstCursor = tripCursorFor(trip, filters);
  const secondCursor = tripCursorFor(middle, filters);
  const byPreviousTrip = new Map([
    ["", { rows: [trip], nextCursor: firstCursor }],
    [trip.trip_id, { rows: [middle], nextCursor: secondCursor }],
    [middle.trip_id, { rows: [last], nextCursor: null }],
  ]);
  let pendingPage = Promise.resolve();
  function holdPage() {
    let release = () => {};
    pendingPage = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }
  const requested: Array<TripCursor | null> = [];
  await page.route("**/api/trips**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.has("page")).toBe(false);
    const { cursor } = Schema.decodeUnknownSync(TripSearch)(
      Object.fromEntries(params),
    );
    requested.push(cursor ?? null);
    const result = byPreviousTrip.get(cursor?.after.trip_id ?? "");
    if (!result) throw new Error("Unexpected trip cursor");
    await pendingPage;
    return route.fulfill({ json: { ...result, total: 3, pageSize: 1 } });
  });
  await page.goto("/?zip=10001");
  await expect(page.getByText("$600", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Trips by pickup date" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Trips", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Revenue", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("img", { name: "Fare revenue by pickup date" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("img", { name: "Fare revenue by pickup date" })
      .locator("circle title")
      .first(),
  ).toHaveText("01-01: $200.00");
  await page.screenshot({
    path: "test-results/overview-revenue.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("link", { name: "Trip explorer", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Matching trips", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/trips-table.png",
    fullPage: true,
    animations: "disabled",
  });
  await expect(page.getByRole("button", { name: /Export/ })).toHaveCount(0);
  const previous = page.getByRole("button", { name: "Previous page" });
  const next = page.getByRole("button", { name: "Next page" });
  await expect(previous).toBeDisabled();
  const releaseNextPage = holdPage();
  try {
    await next.click();
    await expect(next).toHaveAttribute("aria-busy", "true");
    await expect(next.locator(".spinner")).toHaveCSS("animation-name", "spin");
    await expect(previous.locator(".spinner")).toHaveCount(0);
    await expect(
      page.getByRole("cell", { name: "$12.00", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
    await expect(page.getByText("1–1 of 3", { exact: true })).toBeVisible();
    await expect(next).toBeDisabled();
  } finally {
    releaseNextPage();
  }
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "$18.00", exact: true }),
  ).toBeVisible();
  await expect(next.locator(".spinner")).toHaveCount(0);
  await next.click();
  await expect(page.getByText("Page 3", { exact: true })).toBeVisible();
  await expect(page.getByText("3–3 of 3", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "$24.00", exact: true }),
  ).toBeVisible();
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(
    page.getByRole("cell", { name: "$18.00", exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const releasePreviousPage = holdPage();
  try {
    await previous.press("Enter");
    await expect(previous).toBeFocused();
    await expect(previous).toHaveAttribute("aria-busy", "true");
    await expect(previous.locator(".spinner")).toBeVisible();
    await expect(previous.locator(".spinner")).toHaveCSS(
      "animation-name",
      "none",
    );
    await expect(next.locator(".spinner")).toHaveCount(0);
    await expect(next).toBeDisabled();
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  } finally {
    releasePreviousPage();
  }
  await expect(
    page.getByRole("cell", { name: "$12.00", exact: true }),
  ).toBeVisible();
  await expect(previous).toBeDisabled();
  expect(requested).toEqual([
    null,
    firstCursor,
    secondCursor,
    firstCursor,
    null,
  ]);
  await page.getByRole("link", { name: "Trip overview", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL("/trips?zip=10001");
  await expect(
    page.getByRole("heading", { name: "Trip records", exact: true }),
  ).toBeVisible();
});

test("late trip responses cannot overwrite a newer filter selection", async ({
  page,
}) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route("**/api/trips**", async (route) => {
    const zip = new URL(route.request().url()).searchParams.get("zip");
    if (zip === "10001") {
      started = true;
      await pending;
    }
    await route.fulfill({
      json: {
        rows: [{ ...trip, pickup_zip: zip }],
        total: 1,
        pageSize: 25,
        nextCursor: null,
      },
    });
  });
  await page.goto("/trips?zip=10001");
  await expect.poll(() => started).toBe(true);
  await page.getByRole("textbox", { name: "Pickup ZIP code" }).fill("10002");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "10002 → 10019", exact: true }),
  ).toBeVisible();
  const oldResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/trips" &&
      new URL(response.url()).searchParams.get("zip") === "10001",
  );
  release();
  await (await oldResponse).finished();
  await expect(
    page.getByRole("cell", { name: "10001 → 10019", exact: true }),
  ).toHaveCount(0);
});

test("saved view chooser creates, edits, reloads, and deletes views with their filters", async ({
  page,
}) => {
  const stored: import("../../../shared/saved-views").SavedView[] = [];
  await page.route("**/api/saved-views**", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const input =
        request.postDataJSON() as import("../../../shared/saved-views").SavedViewInput;
      expect(input.filters).toEqual({ zip: "10001" });
      const previous = stored.find((savedView) => savedView.id === input.id);
      expect(input.version).toBe(previous?.version ?? null);
      const saved = {
        ...input,
        version: (input.version ?? 0) + 1,
        pinned: false,
        created_at: "2026-11-14T10:00:00Z",
        updated_at: "2026-11-14T10:00:00Z",
      };
      stored.splice(0, stored.length, saved);
      return route.fulfill({ json: saved });
    }
    if (request.method() === "DELETE") {
      expect(new URL(request.url()).searchParams.get("version")).toBe("2");
      stored.splice(0);
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({ json: { rows: stored, nextCursor: null } });
  });
  await page.goto("/trips?zip=10001");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const newSavedView = page.getByRole("button", {
    name: "Save this view",
    exact: true,
  });
  await newSavedView.click();
  await page
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Fare review");
  await page
    .getByRole("textbox", { name: "Finding (optional)", exact: true })
    .fill("Initial finding");
  await page
    .getByRole("dialog", {
      name: "What would you call this view?",
      exact: true,
    })
    .getByRole("button", { name: "Save view", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Open saved view for Fare review",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit Fare review", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Finding (optional)", exact: true })
    .fill("Updated finding");
  await page
    .getByRole("dialog", { name: "Edit saved view", exact: true })
    .getByRole("button", { name: "Save view", exact: true })
    .click();
  await expect(
    page.getByText("Updated finding", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete Fare review", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete view", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Delete this saved view?", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No saved views", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Saved views", exact: true }),
  ).toBeVisible();
});

test("modal backdrop dismissal restores the opener and page scrolling", async ({
  page,
}) => {
  await page.goto("/trips");
  const trigger = page.getByRole("button", {
    name: "Save view",
    exact: true,
  });
  await trigger.click();
  await expect(
    page.getByRole("dialog", {
      name: "What would you call this view?",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.style.overflow),
  ).toBe("hidden");
  await page.mouse.click(4, 4);
  await expect(
    page.getByRole("dialog", {
      name: "What would you call this view?",
      exact: true,
    }),
  ).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.style.overflow),
  ).toBe("");
});

test("recovered Genie answers render Markdown safely and copy the generated SQL", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const reply = {
    conversationId: "conversation",
    messageId: "message",
    text: '**Key finding**\n\n[Reference](https://example.com/report)\n\n[Unsafe](javascript:alert(1))\n\n<img src=x onerror="document.body.dataset.executed=1">',
    queries: [
      {
        sql: "SELECT COUNT(*) FROM samples.nyctaxi.trips",
        description: "Trip count",
        columns: ["trips"],
        rows: [["50"]],
        truncated: false,
      },
    ],
  };
  await page.addInitScript(
    (reply) =>
      sessionStorage.setItem(
        "databricks-effect-app.genie.v1",
        JSON.stringify([
          {
            id: "saved-turn",
            question: "Count trips",
            state: "complete",
            reply,
          },
        ]),
      ),
    reply,
  );
  await page.goto("/genie");
  await expect(page.locator("strong")).toHaveText("Key finding");
  await expect(
    page.getByRole("link", { name: "Reference", exact: true }),
  ).toHaveAttribute("href", "https://example.com/report");
  await expect(
    page.getByRole("link", { name: "Unsafe", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("main img")).toHaveCount(0);
  expect(
    await page.evaluate(() => document.body.dataset.executed),
  ).toBeUndefined();
  await page.getByText("View generated SQL", { exact: true }).click();
  await page.getByRole("button", { name: "Copy SQL", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    reply.queries[0]?.sql,
  );
});

test("trip sorting exposes a native dropdown and applies every choice from page one", async ({
  page,
}) => {
  const searches: URLSearchParams[] = [];
  await page.route("**/api/trips**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    searches.push(query);
    const { cursor, sort } = Schema.decodeUnknownSync(TripSearch)(
      Object.fromEntries(query),
    );
    return route.fulfill({
      json: {
        rows: [trip],
        total: 2,
        pageSize: 1,
        nextCursor: cursor ? null : tripCursorFor(trip, { zip: "10001" }, sort),
      },
    });
  });
  await page.goto("/trips?zip=10001");
  const sort = page.getByRole("combobox", { name: "Sort trips" });
  await expect(sort).toHaveValue("newest");
  expect(
    await sort.evaluate((element) => getComputedStyle(element).appearance),
  ).toBe("auto");
  await expect(sort.getByRole("option")).toHaveText([
    "Latest pickup",
    "Highest fare",
    "Longest distance",
  ]);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  for (const value of ["fare", "distance", "newest"]) {
    await sort.selectOption(value);
    await expect(sort).toHaveValue(value);
    await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
    await expect.poll(() => searches.at(-1)?.get("sort")).toBe(value);
    expect(searches.at(-1)?.has("cursor")).toBe(false);
    expect(searches.at(-1)?.get("zip")).toBe("10001");
  }
  await sort.focus();
  await page.keyboard.press("h");
  await page.keyboard.press("Tab");
  await expect(sort).toHaveValue("fare");
  await expect.poll(() => searches.at(-1)?.get("sort")).toBe("fare");
  await page.screenshot({
    path: "test-results/foldkit-sort.png",
    fullPage: true,
  });
});

test("trip inspector shows recorded endpoints, payment and the full charge", async ({
  page,
}) => {
  await page.route("**/api/trips**", (route) =>
    route.fulfill({
      json: { rows: [trip], total: 1, pageSize: 25, nextCursor: null },
    }),
  );
  await page.route("**/api/trip-comments**", (route) =>
    route.fulfill({ json: { rows: [], nextCursor: null } }),
  );
  await page.goto("/trips");
  await page
    .getByRole("button", { name: /^Details and comments for trip/ })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Record details",
    exact: true,
  });
  await expect(panel.getByText("Cash", { exact: true })).toBeVisible();
  await expect(panel.getByText("$15.80", { exact: true })).toBeVisible();
  await panel.locator("summary").filter({ hasText: "Source details" }).click();
  await expect(
    panel.getByText("40.75000, -73.99000", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("40.76000, -73.98000", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("yellow_tripdata_2016-01.csv.gz", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/enriched-trip.png",
    fullPage: true,
    animations: "disabled",
  });
});
