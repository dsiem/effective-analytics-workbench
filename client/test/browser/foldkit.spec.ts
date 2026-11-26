import { expect, test } from "@playwright/test";
import {
  fixtureContinuation,
  fixtureCursor,
  tripPreviewResponse,
  tripSummaryFor,
} from "../trip-fixture";

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

test("overview charts and browser history work through the runtime", async ({
  page,
}) => {
  await page.route("**/api/overview**", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/trips**", (route) =>
    route.fulfill(tripPreviewResponse([trip])),
  );
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
  await page.getByRole("link", { name: "Trip explorer", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Matching trips", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1 trip", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Find by trip ID")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Export/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Trip overview", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL("/trips?zip=10001");
  await expect(
    page.getByRole("heading", { name: "Trip records", exact: true }),
  ).toBeVisible();
});

test("Overview cancels pending requests when filters change or the route closes", async ({
  page,
}) => {
  const started: Array<string | null> = [];
  const cancelled: Array<string | null> = [];
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/overview")
      cancelled.push(url.searchParams.get("zip"));
  });
  await page.route("**/api/overview**", (route) => {
    const url = new URL(route.request().url());
    started.push(url.searchParams.get("zip"));
    if (started.length > 2) return route.fulfill({ json: overview });
  });
  await page.route("**/api/trips**", (route) =>
    route.fulfill(tripPreviewResponse([trip])),
  );

  await page.goto("/?zip=10001");
  await expect.poll(() => started).toEqual(["10001"]);
  await page.getByRole("textbox", { name: "Pickup ZIP code" }).fill("10002");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => started).toEqual(["10001", "10002"]);
  await expect.poll(() => cancelled).toEqual(["10001"]);

  await page.getByRole("link", { name: "Trip explorer", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Trip records" }),
  ).toBeVisible();
  await expect.poll(() => cancelled).toEqual(["10001", "10002"]);
  await page.getByRole("link", { name: "Trip overview", exact: true }).click();
  await expect(page.getByText("$600", { exact: true }).first()).toBeVisible();
});

test("Records browses all 10,000 returned rows without growing the table DOM", async ({
  page,
}) => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    ...trip,
    trip_id: `trip-${index}`,
    fare: index,
  }));
  const last = rows.at(-1);
  if (!last) throw new Error("Expected a populated shortlist");
  const requests: Array<string | null> = [];
  await page.route("**/api/metadata", (route) =>
    route.fulfill({
      json: { from: "2016-01-01", to: "2016-02-29", trips: 20_000 },
    }),
  );
  await page.route("**/api/trip-comment-counts**", (route) => {
    const ids: string[] = JSON.parse(
      new URL(route.request().url()).searchParams.get("tripIds") ?? "[]",
    );
    return route.fulfill({
      json: Object.fromEntries(ids.map((id) => [id, 0])),
    });
  });
  await page.route("**/api/trips**", (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get("from");
    requests.push(from);
    expect(url.searchParams.has("cursor")).toBe(false);
    return route.fulfill(
      from ? tripPreviewResponse([last]) : tripPreviewResponse(rows, true),
    );
  });
  await page.goto("/trips?zip=10001");
  const table = page.getByRole("table", { name: "Matching trips" });
  await expect(
    page.getByText("10,000 shown · more match", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/More trips match/)).toHaveCount(0);
  await expect(table.getByRole("row")).toHaveCount(26);
  const scroller = page.getByRole("region", {
    name: "Scrollable trip records",
  });
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const lastFare = table.getByRole("cell", { name: "$9,999.00", exact: true });
  await lastFare.scrollIntoViewIfNeeded();
  await expect(lastFare).toBeInViewport();
  await expect(table.getByRole("row")).toHaveCount(26);
  expect(requests).toEqual([null]);
  await page.getByLabel("Pickup start date").fill("2016-01-01");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("1 trip", { exact: true })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(2);
  expect(requests).toEqual([null, "2016-01-01"]);
});

test("Records renders the first JSON page while the next page is still pending", async ({
  page,
}) => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paths: string[] = [];
  await page.route("**/api/trips**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    if (path === "/api/trips")
      return route.fulfill(tripPreviewResponse([trip], false, fixtureCursor));
    expect(path).toBe(fixtureContinuation);
    await pending;
    return route.fulfill(
      tripPreviewResponse([{ ...trip, trip_id: "second", fare: 37 }]),
    );
  });
  await page.goto("/trips");
  const table = page.getByRole("table", { name: "Matching trips" });
  await expect(
    table.getByRole("cell", { name: "$12.00", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1 loaded", { exact: true })).toBeVisible();
  await expect(
    table.getByRole("cell", { name: "$37.00", exact: true }),
  ).toHaveCount(0);
  release();
  await expect(
    table.getByRole("cell", { name: "$37.00", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("2 trips", { exact: true })).toBeVisible();
  expect(paths).toEqual(["/api/trips", fixtureContinuation]);
});

test("Records rejects malformed and repeated continuation cursors without requesting them", async ({
  page,
}) => {
  const paths: string[] = [];
  let cursor = "https://other.example/api/trips/pages/invalid";
  await page.route("https://other.example/**", (route) => {
    paths.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/trips**", (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    if (path === "/api/trips")
      return route.fulfill(tripPreviewResponse([trip], false, cursor));
    return route.fulfill(
      tripPreviewResponse([{ ...trip, trip_id: "second" }], false, cursor),
    );
  });
  await page.goto("/trips");
  await expect(page.getByText(/Unable to complete the request/)).toBeVisible();
  expect(paths).toEqual(["/api/trips"]);
  cursor = fixtureCursor;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(/repeated a trip page/i)).toBeVisible();
  expect(paths).toEqual(["/api/trips", "/api/trips", fixtureContinuation]);
});

test("one retry reloads incomplete Records and unavailable comment counts", async ({
  page,
}) => {
  const first = tripSummaryFor(trip);
  const other = { ...first, trip_id: "retry-trip", fare: 42 };
  let requests = 0;
  let failCounts = () => {};
  const countFailure = new Promise<void>((resolve) => {
    failCounts = resolve;
  });
  await page.route("**/api/trip-comment-counts**", async (route) => {
    if (requests > 1) return route.fulfill({ json: { [other.trip_id]: 1 } });
    await countFailure;
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: "lakebase_unavailable",
          message: "Comment counts are temporarily unavailable.",
        },
      },
    });
  });
  await page.route("**/api/trips**", (route) => {
    if (new URL(route.request().url()).pathname === fixtureContinuation) {
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "warehouse_unavailable",
            message: "The second trip page is temporarily unavailable.",
          },
        },
      });
    }
    requests++;
    return route.fulfill(
      requests === 1
        ? tripPreviewResponse([first], false, fixtureCursor)
        : tripPreviewResponse([other]),
    );
  });

  await page.goto("/trips");
  const table = page.getByRole("table", { name: "Matching trips" });
  const firstFare = table.getByRole("cell", { name: "$12.00", exact: true });
  await expect(
    page.getByText(/second trip page is temporarily unavailable/i),
  ).toBeVisible();
  await expect(firstFare).toBeVisible();
  await expect(page.getByText("1 loaded", { exact: true })).toBeVisible();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  const originalTop = await retry.evaluate(
    (button) => button.getBoundingClientRect().top,
  );
  failCounts();
  await expect(
    page.getByText("Comment counts are temporarily unavailable."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Try again|Retry comment counts)$/ }),
  ).toHaveCount(1);
  expect(
    await retry.evaluate((button) => button.getBoundingClientRect().top),
  ).toBe(originalTop);
  await retry.click();
  await expect(
    table.getByRole("cell", { name: "$42.00", exact: true }),
  ).toBeVisible();
  await expect(firstFare).toHaveCount(0);
  await expect(page.getByText("1 trip", { exact: true })).toBeVisible();
  await expect(
    table.getByRole("button", { name: /^1 comment for trip/ }),
  ).toBeVisible();
  expect(requests).toBe(2);
});

test("changing filters cancels a pending Records request", async ({ page }) => {
  let started = false;
  await page.route("**/api/trips**", async (route) => {
    const zip = new URL(route.request().url()).searchParams.get("zip");
    if (zip === "10001") {
      started = true;
      return;
    }
    await route.fulfill(
      tripPreviewResponse([{ ...trip, pickup_zip: zip ?? "10001" }]),
    );
  });
  await page.goto("/trips?zip=10001");
  await expect.poll(() => started).toBe(true);
  const cancelled = page.waitForEvent("requestfailed", (request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/trips" && url.searchParams.get("zip") === "10001"
    );
  });
  await page.getByRole("textbox", { name: "Pickup ZIP code" }).fill("10002");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "10002 → 10019", exact: true }),
  ).toBeVisible();
  await cancelled;
  await expect(
    page.getByRole("cell", { name: "10001 → 10019", exact: true }),
  ).toHaveCount(0);
});

test("virtual rows keep their place at large text sizes and preserve keyboard access", async ({
  page,
}) => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    ...trip,
    trip_id: `trip-${index}`,
  }));
  await page.route(
    (url) => url.pathname === "/api/trips",
    (route) => route.fulfill(tripPreviewResponse(rows)),
  );
  await page.route(
    (url) => url.pathname === "/api/trip-comment-counts",
    (route) => {
      const ids: string[] = JSON.parse(
        new URL(route.request().url()).searchParams.get("tripIds") ?? "[]",
      );
      return route.fulfill({
        json: Object.fromEntries(ids.map((id) => [id, 0])),
      });
    },
  );
  await page.goto("/trips?zip=10001");
  const scroller = page.getByRole("region", {
    name: "Scrollable trip records",
  });
  await expect(scroller.getByRole("table")).toBeVisible();

  const firstVisibleRowAt = (scrollTop: number) =>
    scroller.evaluate(async (element, top) => {
      element.scrollTop = top;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const header = element.querySelector("th")?.getBoundingClientRect();
      const bottom = element.getBoundingClientRect().bottom;
      const rows = Array.from(element.querySelectorAll("tr[aria-rowindex]"));
      const first = rows.find((row) => {
        const bounds = row.getBoundingClientRect();
        return header && bounds.bottom > header.bottom && bounds.top < bottom;
      });
      if (!first) throw new Error("No trip row is visible");
      return Number(first.getAttribute("aria-rowindex"));
    }, scrollTop);

  const scrollTop = () => scroller.evaluate((element) => element.scrollTop);
  await firstVisibleRowAt(374);
  await scroller.focus();
  const beforeTab = await scrollTop();
  await page.keyboard.press("Tab");
  await expect(scroller.locator("tr button:focus")).toHaveCount(1);
  expect(await scrollTop()).toBe(beforeTab);
  await page.keyboard.press("Shift+Tab");
  await expect(scroller).toBeFocused();
  expect(await scrollTop()).toBe(beforeTab);

  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  const before = await firstVisibleRowAt(483);
  const after = await firstVisibleRowAt(484);
  expect.soft(Math.abs(after - before)).toBeLessThanOrEqual(1);

  await firstVisibleRowAt(0);
  const action = scroller
    .getByRole("button", { name: /^Details and comments/ })
    .first();
  await action.focus();
  await expect(action).toBeFocused();
  await firstVisibleRowAt(4_400);
  await expect(scroller).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(scroller.locator("tr button:focus")).toHaveCount(1);

  await scroller.focus();
  const beforePageDown = await scrollTop();
  await page.keyboard.press("PageDown");
  await expect.poll(scrollTop).toBeGreaterThan(beforePageDown + 200);
});

for (const { name, width, height, count, fontSize } of [
  {
    name: "one trip at a larger text size",
    width: 390,
    height: 700,
    count: 1,
    fontSize: 18,
  },
  {
    name: "a viewport shorter than a full row",
    width: 320,
    height: 150,
    count: 30,
    fontSize: 16,
  },
]) {
  test(`Records row actions are keyboard-reachable with ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.route("**/api/trips**", (route) =>
      route.fulfill(
        tripPreviewResponse(
          Array.from({ length: count }, (_, index) => ({
            ...trip,
            trip_id: `trip-${index}`,
          })),
        ),
      ),
    );
    await page.goto("/trips");
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = `${size}px`;
    }, fontSize);

    const scroller = page.getByRole("region", {
      name: "Scrollable trip records",
    });
    const firstAction = scroller.locator('tr button[tabindex="0"]').first();
    await expect(firstAction).toBeAttached();
    await scroller.focus();
    await page.keyboard.press("Tab");
    await expect(firstAction).toBeFocused();
  });
}

test("saved view chooser creates, edits, reloads, and deletes views with their filters", async ({
  page,
}) => {
  const stored: import("@dsiem/analytics-shared/saved-views").SavedView[] = [];
  await page.route("**/api/saved-views**", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const input =
        request.postDataJSON() as import("@dsiem/analytics-shared/saved-views").SavedViewInput;
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
  browserName,
}) => {
  if (browserName === "chromium")
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
  if (browserName === "chromium")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      reply.queries[0]?.sql,
    );
});

test("changing the trip sort starts a fresh query and keeps the filters", async ({
  page,
}) => {
  const searches: URLSearchParams[] = [];
  await page.route("**/api/trips**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    searches.push(query);
    return route.fulfill(tripPreviewResponse([trip], true));
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
  await expect(
    page.getByText("1 shown · more match", { exact: true }),
  ).toBeVisible();
  await sort.focus();
  for (const value of ["fare", "distance", "newest"]) {
    await sort.selectOption(value);
    await expect(sort).toHaveValue(value);
    await expect(
      page.getByText("1 shown · more match", { exact: true }),
    ).toBeVisible();
    await expect(sort).toBeFocused();
    await expect.poll(() => searches.at(-1)?.get("sort")).toBe(value);
    expect(searches.at(-1)?.has("cursor")).toBe(false);
    expect(searches.at(-1)?.get("zip")).toBe("10001");
  }
  await sort.focus();
  await page.keyboard.press("h");
  await page.keyboard.press("Tab");
  await expect(sort).toHaveValue("fare");
  await expect.poll(() => searches.at(-1)?.get("sort")).toBe("fare");
});

test("trip inspector shows recorded endpoints, payment and the full charge", async ({
  page,
}) => {
  const summary = tripSummaryFor(trip);
  const requestedDetails: Array<string | null> = [];
  await page.route("**/api/trips**", (route) =>
    route.fulfill(tripPreviewResponse([summary])),
  );
  await page.route(
    (url) => url.pathname === "/api/trip-details",
    (route) => {
      requestedDetails.push(
        new URL(route.request().url()).searchParams.get("tripId"),
      );
      return route.fulfill({ json: trip });
    },
  );
  await page.route("**/api/trip-comments**", (route) =>
    route.fulfill({ json: { rows: [], nextCursor: null } }),
  );
  await page.goto("/trips");
  const open = page.getByRole("button", {
    name: /^Details and comments for trip/,
  });
  await expect(open).toBeVisible();
  expect(requestedDetails).toEqual([]);
  await open.click();
  const panel = page.getByRole("dialog", {
    name: "Record details",
    exact: true,
  });
  await expect(panel.getByText("Cash", { exact: true })).toBeVisible();
  expect(requestedDetails).toEqual([summary.trip_id]);
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
});
