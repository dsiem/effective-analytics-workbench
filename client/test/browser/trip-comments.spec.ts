import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  tripDetails,
  tripPreviewResponse,
  tripSummaryFor,
} from "../trip-fixture";
import type {
  TripComment,
  TripCommentInput,
} from "@dsiem/analytics-shared/trip-comments";
import type { Trip, TripSnapshot } from "@dsiem/analytics-shared/trips";

const historicalTrip: TripSnapshot = {
  trip_id: "7b2c6ab2-6f7d-4f8a-a05f-d07e4eb84a19",
  pickup_at: "2016-01-20 09:42:00",
  dropoff_at: "2016-01-20 09:56:00",
  pickup_zip: "10001",
  dropoff_zip: "10019",
  distance: 3.2,
  fare: 18.5,
  duration: 14,
};
const trip: Trip = { ...historicalTrip, details: tripDetails };
const otherTrip = { ...trip, trip_id: randomUUID() };
const enrichedTrip: Trip = {
  ...trip,
  details: {
    source_file: "yellow_tripdata_2016-01.csv.gz",
    vendor_id: 2,
    passenger_count: 1,
    rate_code_id: 1,
    store_and_fwd_flag: "N",
    payment_type: 2,
    pickup_location: { latitude: 40.75, longitude: -73.99 },
    dropoff_location: { latitude: 40.76, longitude: -73.98 },
    tip_amount: 0,
    tolls_amount: 2.5,
    extra: 0.5,
    mta_tax: 0.5,
    improvement_surcharge: 0.3,
    total_amount: 22.3,
  },
};
const author = { name: "Avery Morgan", email: "avery@example.test" };
const makeComment = (body: string): TripComment => ({
  id: randomUUID(),
  trip: historicalTrip,
  body,
  author,
  created_at: "2026-11-14T10:00:00Z",
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/metadata", (route) =>
    route.fulfill({ json: { from: "2016-01-01", to: "2016-02-29", trips: 2 } }),
  );
  await page.route("**/api/me", (route) => route.fulfill({ json: author }));
  await page.route("**/api/trips**", (route) =>
    route.fulfill(
      tripPreviewResponse([tripSummaryFor(trip), tripSummaryFor(otherTrip)]),
    ),
  );
  await page.route("**/api/trip-details?**", (route) => {
    const tripId = new URL(route.request().url()).searchParams.get("tripId");
    return route.fulfill({
      json: tripId === otherTrip.trip_id ? otherTrip : trip,
    });
  });
  await page.route("**/api/trip-comment-counts**", (route) =>
    route.fulfill({ json: { [trip.trip_id]: 0, [otherTrip.trip_id]: 0 } }),
  );
});

for (const width of [1440, 360]) {
  test(`compact inspector keeps the summary and comments together at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.route("**/api/trips**", (route) =>
      route.fulfill(tripPreviewResponse([tripSummaryFor(enrichedTrip)])),
    );
    await page.route("**/api/trip-details?**", (route) =>
      route.fulfill({ json: enrichedTrip }),
    );
    await page.route("**/api/trip-comments**", (route) =>
      route.fulfill({
        json: {
          rows: [makeComment("Compare this fare with nearby trips.")],
          nextCursor: null,
        },
      }),
    );
    await page.goto("/trips");
    await page
      .getByRole("button", { name: /^Details and comments for trip/ })
      .click();
    const panel = page.getByRole("dialog", {
      name: "Record details",
      exact: true,
    });
    const summary = panel.getByRole("region", { name: "Selected trip" });
    await expect(summary).toContainText("$22.30");
    await expect(summary.getByText("Cash", { exact: true })).toBeVisible();
    await expect(
      summary.getByText(trip.pickup_at, { exact: true }),
    ).toBeVisible();
    await expect(
      summary.getByText(trip.dropoff_at, { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: "Comments", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      panel.getByText("Compare this fare with nearby trips.", { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const field = panel.getByRole("textbox", {
      name: "Add a comment",
      exact: true,
    });
    await expect(field).toBeInViewport({ ratio: 1 });
    const compactHeight = (await field.boundingBox())?.height ?? 0;
    expect(compactHeight).toBeLessThanOrEqual(40);
    const fare = panel.locator("summary").filter({ hasText: "Fare breakdown" });
    const source = panel
      .locator("summary")
      .filter({ hasText: "Source details" });
    await expect(panel.getByText("$2.50", { exact: true })).not.toBeVisible();
    await fare.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByText("$2.50", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(panel.getByText("$2.50", { exact: true })).not.toBeVisible();
    await expect(
      panel.getByText("yellow_tripdata_2016-01.csv.gz", { exact: true }),
    ).not.toBeVisible();
    await source.click();
    await expect(
      panel.getByText("40.75000, -73.99000", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText("yellow_tripdata_2016-01.csv.gz", { exact: true }),
    ).toBeVisible();
    await field.focus();
    expect((await field.boundingBox())?.height).toBeGreaterThan(compactHeight);
    await field.fill("Keep this investigation draft");
    await source.click();
    await expect(field).toHaveValue("Keep this investigation draft");
    expect((await field.boundingBox())?.height).toBeGreaterThan(compactHeight);
    await field.fill("");
    await panel
      .getByRole("heading", { name: "Record details", exact: true })
      .focus();
    await expect(field).toHaveCSS("height", `${compactHeight}px`);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: /^0 comments for trip/ })
      .first()
      .click();
    await expect(
      panel.getByRole("heading", { name: "Comments", exact: true }),
    ).toBeFocused();
    await expect(
      panel.getByRole("heading", { name: "Comments", exact: true }),
    ).toBeInViewport({ ratio: 1 });
  });
}

for (const width of [1440, 360]) {
  test(`compact row controls open details and comments directly at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    const countRequests: string[][] = [];
    await page.route("**/api/trip-comment-counts**", (route) => {
      countRequests.push(
        JSON.parse(
          new URL(route.request().url()).searchParams.get("tripIds") ?? "null",
        ),
      );
      return route.fulfill({
        json: { [trip.trip_id]: 53, [otherTrip.trip_id]: 0 },
      });
    });
    await page.route("**/api/trip-comments**", (route) =>
      route.fulfill({ json: { rows: [], nextCursor: null } }),
    );
    await page.goto("/trips");
    const table = page.getByRole("table", {
      name: "Matching trips",
      exact: true,
    });
    const conversation = table.getByRole("button", {
      name: /^53 comments for trip/,
    });
    await expect(conversation).toBeVisible();
    await expect(
      table.getByRole("button", { name: /^0 comments for trip/ }),
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Discussion" }),
    ).toHaveCount(0);
    await expect(
      table.getByRole("button", { name: trip.pickup_at, exact: true }),
    ).toHaveCount(0);
    expect(countRequests).toEqual([[trip.trip_id, otherTrip.trip_id]]);
    await conversation.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("dialog", {
      name: "Record details",
      exact: true,
    });
    await expect(
      panel.getByRole("heading", { name: "Comments", exact: true }),
    ).toBeFocused();
    await expect(
      panel.getByRole("heading", { name: "Comments", exact: true }),
    ).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(conversation).toBeFocused();
    const details = table
      .getByRole("button", { name: /^Details and comments for trip/ })
      .first();
    await details.click();
    await expect(
      panel.getByRole("heading", { name: "Record details", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(details).toBeFocused();
    const actions = table.locator("tbody tr").first().locator("td").last();
    const box = await actions.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(box?.height ?? 0).toBeLessThanOrEqual(width === 360 ? 56 : 44);
  });
}

test("comment counts can be retried after opening a trip while they are unavailable", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/trip-comment-counts**", (route) => {
    attempts += 1;
    if (attempts > 1)
      return route.fulfill({
        json: { [trip.trip_id]: 0, [otherTrip.trip_id]: 0 },
      });
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: "lakebase_unavailable",
          message: "Comments are temporarily unavailable.",
        },
      },
    });
  });
  await page.route("**/api/trip-comments**", (route) =>
    route.fulfill({ json: { rows: [], nextCursor: null } }),
  );
  await page.goto("/trips");
  const unknown = page
    .getByRole("button", { name: /^Comment count unavailable for trip/ })
    .first();
  await expect(unknown).toHaveText("–");
  await unknown.click();
  await expect(
    page.getByRole("dialog", { name: "Record details" }),
  ).toContainText("Know the story behind this ride?");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^0 comments for trip/ }),
  ).toHaveCount(2);
});

test("a comment can be posted without trip details and retried with the same snapshot", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/trip-details?**", (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({
          status: 503,
          json: {
            error: {
              code: "warehouse_unavailable",
              message: "The warehouse is unavailable.",
            },
          },
        })
      : route.fulfill({ json: enrichedTrip });
  });
  const posts: TripCommentInput[] = [];
  await page.route("**/api/trip-comments**", (route) => {
    if (route.request().method() === "POST") {
      const input: TripCommentInput = route.request().postDataJSON();
      posts.push(input);
      return posts.length === 1
        ? route.fulfill({
            status: 503,
            json: {
              error: {
                code: "lakebase_unavailable",
                message: "Lakebase is unavailable.",
              },
            },
          })
        : route.fulfill({
            json: { ...input, author, created_at: "2026-11-14T10:00:00Z" },
          });
    }
    return route.fulfill({
      json: { rows: [makeComment("Check the fare")], nextCursor: null },
    });
  });
  await page.goto("/trips");
  await page
    .getByRole("button", { name: /^Details and comments for trip/ })
    .first()
    .click();
  const panel = page.getByRole("dialog", { name: "Record details" });
  await expect(
    panel.getByText("Check the fare", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveText(
    "The warehouse is unavailable.",
  );
  const draft = panel.getByRole("textbox", { name: "Add a comment" });
  await draft.fill("Confirm the source");
  const post = panel.getByRole("button", { name: "Post comment" });
  await expect(post).toBeEnabled();
  await post.click();
  await expect(
    panel.getByText("Lakebase is unavailable.", { exact: false }),
  ).toBeVisible();
  expect(posts[0]).toMatchObject({
    trip: historicalTrip,
    body: "Confirm the source",
  });
  expect(posts[0]?.trip.details).toBeUndefined();
  await panel
    .getByRole("button", { name: "Retry loading trip details" })
    .click();
  await expect(panel.getByText("$22.30", { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("Confirm the source");
  await post.click();
  await expect(
    panel.getByText("Comment posted", { exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([posts[0], posts[0]]);
  expect(attempts).toBe(2);
});

test("denied comment access leaves trip records, details and navigation usable", async ({
  page,
}) => {
  const message = "The trip is in view. The comments are under lock.";
  const denied = {
    status: 403,
    json: { error: { code: "permission_denied", message } },
  };
  await page.route("**/api/trip-comment-counts**", (route) =>
    route.fulfill(denied),
  );
  await page.route("**/api/trip-comments**", (route) => route.fulfill(denied));
  await page.route("**/api/analysis-runs", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/trips");
  const table = page.getByRole("table", { name: "Matching trips" });
  await expect(
    table.getByRole("cell", { name: "10001 → 10019" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(
    "The trip is in view. The comments are under lock.",
  );
  await expect(
    page.getByRole("alert").locator('svg[aria-hidden="true"]'),
  ).toBeVisible();
  await table
    .getByRole("button", { name: /^Details and comments for trip/ })
    .first()
    .click();
  const details = page.getByRole("dialog", { name: "Record details" });
  await expect(
    details.getByRole("region", { name: "Selected trip" }),
  ).toContainText(trip.pickup_at);
  await expect(details.getByRole("alert")).toHaveText(
    "The trip is in view. The comments are under lock.",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Analysis runs", exact: true }).click();
  await expect(
    page.getByText("No runs yet. Start a new run to compare two weeks."),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const width of [1440, 360]) {
  test(`trip comments stay attached after reload and distinguish similar records at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    const stored: TripComment[] = [];
    await page.route("**/api/trip-comment-counts**", (route) =>
      route.fulfill({
        json: { [trip.trip_id]: stored.length, [otherTrip.trip_id]: 0 },
      }),
    );
    await page.route("**/api/trip-comments**", (route) => {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON() as TripCommentInput;
        expect(input.trip).toEqual(trip);
        const saved = { ...input, author, created_at: "2026-11-14T10:00:00Z" };
        stored.push(saved);
        return route.fulfill({ json: saved });
      }
      const params = new URL(route.request().url()).searchParams;
      expect([...params.keys()]).toEqual(["tripId"]);
      const selected = params.get("tripId");
      return route.fulfill({
        json: {
          rows: stored.filter((comment) => comment.trip.trip_id === selected),
          nextCursor: null,
        },
      });
    });
    await page.goto("/trips?zip=10001");
    const inspect = page.getByRole("button", {
      name: /^Details and comments for trip/,
    });
    await inspect.first().click();
    const panel = page.getByRole("dialog", {
      name: "Record details",
      exact: true,
    });
    await expect(
      panel.getByRole("region", { name: "Selected trip" }),
    ).toContainText("$18.50");
    await expect(panel).toContainText("Know the story behind this ride?");
    await expect(
      panel.getByRole("button", { name: "Post comment", exact: true }),
    ).toBeDisabled();
    await panel
      .getByRole("textbox", { name: "Add a comment", exact: true })
      .fill("Check this fare against nearby trips.");
    await panel
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(
      panel.getByText("Check this fare against nearby trips.", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("status")).toHaveText("Comment posted");
    await expect(
      panel.getByRole("textbox", { name: "Add a comment" }),
    ).toHaveValue("");
    await expect(panel).toContainText(author.name);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(inspect.first()).toBeFocused();
    await expect(
      page.getByRole("button", { name: /^1 comment for trip/ }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: /^1 comment for trip/ }),
    ).toBeVisible();
    await inspect.first().click();
    await expect(
      panel.getByText("Check this fare against nearby trips.", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await inspect.nth(1).click();
    await expect(panel).toContainText("$18.50");
    await expect(panel).toContainText("Know the story behind this ride?");
    await expect(
      panel.getByText("Check this fare against nearby trips.", { exact: true }),
    ).toHaveCount(0);
    expect(stored).toHaveLength(1);
  });
}

test("drafts follow the trip ID when refreshed record details change", async ({
  page,
}) => {
  await page.route("**/api/trip-comments**", (route) =>
    route.fulfill({ json: { rows: [], nextCursor: null } }),
  );
  await page.goto("/trips");
  const inspect = page.getByRole("button", {
    name: /^Details and comments for trip/,
  });
  await inspect.first().click();
  const panel = page.getByRole("dialog", {
    name: "Record details",
    exact: true,
  });
  const field = panel.getByRole("textbox", { name: "Add a comment" });
  await field.fill("Keep investigating this trip");
  await page.keyboard.press("Escape");
  await page.route("**/api/trips**", (route) =>
    route.fulfill(tripPreviewResponse([{ ...tripSummaryFor(trip), fare: 25 }])),
  );
  await page.route("**/api/trip-details?**", (route) =>
    route.fulfill({ json: { ...trip, fare: 25 } }),
  );
  await page.getByRole("combobox", { name: "Sort trips" }).selectOption("fare");
  await expect(
    page.getByRole("cell", { name: "$25.00", exact: true }),
  ).toBeVisible();
  await inspect.first().click();
  await expect(panel).toContainText("$25.00");
  await expect(field).toHaveValue("Keep investigating this trip");
});

test("failed posts keep the draft across inspection and retry the same submission", async ({
  page,
}) => {
  let failing = true;
  const submitted: TripCommentInput[] = [];
  const stored: TripComment[] = [];
  await page.route("**/api/trip-comments**", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { rows: stored, nextCursor: null } });
    const input = route.request().postDataJSON() as TripCommentInput;
    submitted.push(input);
    if (failing)
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "lakebase_unavailable",
            message: "Comments are temporarily unavailable.",
          },
        },
      });
    const saved = { ...input, author, created_at: "2026-11-14T10:00:00Z" };
    stored.push(saved);
    return route.fulfill({ json: saved });
  });
  await page.goto("/trips");
  const inspect = page.getByRole("button", {
    name: /^Details and comments for trip/,
  });
  await inspect.first().click();
  const panel = page.getByRole("dialog", {
    name: "Record details",
    exact: true,
  });
  const field = panel.getByRole("textbox", {
    name: "Add a comment",
    exact: true,
  });
  await field.fill("My unsaved investigation");
  await panel
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText(
    "Your draft is kept here",
  );
  await expect(field).toHaveValue("My unsaved investigation");
  await page.keyboard.press("Escape");
  await inspect.nth(1).click();
  await expect(field).toHaveValue("");
  await page.keyboard.press("Escape");
  await inspect.first().click();
  await expect(field).toHaveValue("My unsaved investigation");
  failing = false;
  await panel
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(field).toHaveValue("");
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
});

test("loading older comments retries the same continuation request", async ({
  page,
}) => {
  const recent = makeComment("Recent comment");
  const older = makeComment("Older comment");
  const cursor = { id: recent.id, createdAt: "2026-11-14T10:00:00.000000Z" };
  const requests: { tripId: string | null; cursor: unknown }[] = [];
  await page.route("**/api/trip-comments**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const continuation = query.get("cursor");
    if (continuation === null)
      return route.fulfill({ json: { rows: [recent], nextCursor: cursor } });
    requests.push({
      tripId: query.get("tripId"),
      cursor: JSON.parse(continuation),
    });
    if (requests.length === 1)
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "lakebase_unavailable",
            message: "Try loading older comments again.",
          },
        },
      });
    return route.fulfill({ json: { rows: [older], nextCursor: null } });
  });
  await page.goto("/trips");
  await page
    .getByRole("button", { name: /^Details and comments for trip/ })
    .first()
    .click();
  const panel = page.getByRole("dialog", { name: "Record details" });
  await panel.getByRole("button", { name: "Load older comments" }).click();
  await panel.getByRole("button", { name: "Retry loading comments" }).click();
  await expect(panel.getByText("Older comment", { exact: true })).toBeVisible();
  expect(requests).toEqual([
    { tripId: trip.trip_id, cursor },
    { tripId: trip.trip_id, cursor },
  ]);
});

test("typing while a comment posts keeps the new draft with a distinct retry identity", async ({
  page,
}) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitted: TripCommentInput[] = [];
  const stored: TripComment[] = [];
  await page.route("**/api/trip-comments**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { rows: stored, nextCursor: null } });
    const input = route.request().postDataJSON() as TripCommentInput;
    submitted.push(input);
    if (submitted.length === 1) await pending;
    const saved = { ...input, author, created_at: "2026-11-14T10:00:00Z" };
    stored.push(saved);
    return route.fulfill({ json: saved });
  });
  await page.goto("/trips");
  await page
    .getByRole("button", { name: /^Details and comments for trip/ })
    .first()
    .click();
  const panel = page.getByRole("dialog", { name: "Record details" });
  const field = panel.getByRole("textbox", { name: "Add a comment" });
  await field.fill("First finding");
  await panel
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect.poll(() => submitted.length).toBe(1);
  await field.fill("Next finding, typed while posting");
  release();
  await expect(panel.getByRole("status")).toHaveText("Comment posted");
  await expect(field).toHaveValue("Next finding, typed while posting");
  await panel
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(field).toHaveValue("");
  expect(submitted).toHaveLength(2);
  expect(submitted[1]?.id).not.toBe(submitted[0]?.id);
});

test("scrolling after a count denial leaves the table steady until manual retry", async ({
  page,
}) => {
  const rows = Array.from({ length: 80 }, (_, index) => ({
    ...tripSummaryFor(trip),
    trip_id: `row-${index}`,
  }));
  await page.route("**/api/trips**", (route) =>
    route.fulfill(tripPreviewResponse(rows)),
  );
  const requests: string[][] = [];
  await page.route("**/api/trip-comment-counts**", (route) => {
    const ids: string[] = JSON.parse(
      new URL(route.request().url()).searchParams.get("tripIds") ?? "[]",
    );
    requests.push(ids);
    return requests.length === 1
      ? route.fulfill({
          status: 403,
          json: {
            error: {
              code: "permission_denied",
              message: "Comments are under lock.",
            },
          },
        })
      : route.fulfill({ json: Object.fromEntries(ids.map((id) => [id, 0])) });
  });

  await page.goto("/trips");
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  const scroller = page.getByRole("region", {
    name: "Scrollable trip records",
  });
  const top = await scroller.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  for (const offset of [132, 396, 704]) {
    await scroller.evaluate((element, scrollTop) => {
      element.scrollTop = scrollTop;
    }, offset);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBe(offset);
    await expect(retry).toBeVisible();
    expect(
      await scroller.evaluate((element) => element.getBoundingClientRect().top),
    ).toBe(top);
  }
  expect(requests).toHaveLength(1);
  await retry.click();
  await expect(retry).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.[0]).toBe("row-16");
});

test("closing the inspector cancels its pending detail and comment reads", async ({
  page,
}) => {
  const started: string[] = [];
  for (const path of ["/api/trip-details", "/api/trip-comments"]) {
    await page.route(
      (url) => url.pathname === path,
      (route) => {
        const tripId = new URL(route.request().url()).searchParams.get(
          "tripId",
        );
        if (tripId === trip.trip_id) {
          started.push(path);
          return;
        }
        return route.fulfill({
          json:
            path === "/api/trip-details"
              ? otherTrip
              : { rows: [], nextCursor: null },
        });
      },
    );
  }
  await page.goto("/trips");
  const details = page.getByRole("button", {
    name: /^Details and comments for trip/,
  });
  await details.first().click();
  const panel = page.getByRole("dialog", { name: "Record details" });
  await expect(
    panel.getByRole("heading", { name: "Record details" }),
  ).toBeFocused();
  await expect
    .poll(() => started.toSorted())
    .toEqual(["/api/trip-comments", "/api/trip-details"]);
  const failures = started.map((path) =>
    page.waitForEvent(
      "requestfailed",
      (request) => new URL(request.url()).pathname === path,
    ),
  );
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await Promise.all(failures);
  await details.nth(1).click();
  await expect(
    panel.getByText(otherTrip.pickup_at, { exact: true }),
  ).toBeVisible();
});
