import { tripPreviewResponse } from "../trip-fixture";
import { expect, type Page, test } from "@playwright/test";
import { gpsFixture } from "../gps-fixture";

const filters = { from: "2016-01-10", to: "2016-01-20", zip: "10001" };
const query = new URLSearchParams(filters).toString();
const operation = { conversationId: "conversation", messageId: "message" };
const messagePath = "**/api/genie/conversation/messages/message";
const overview = {
  summary: {
    trips: 2184,
    revenue: 29308,
    avg_fare: 13.42,
    avg_distance: 2.8,
    avg_duration: 14,
  },
  daily: [
    { day: "2016-01-10", trips: 184, revenue: 2469 },
    { day: "2016-01-11", trips: 280, revenue: 3757 },
  ],
  hourly: [
    { hour: 8, trips: 100, avg_fare: 12 },
    { hour: 18, trips: 200, avg_fare: 15 },
  ],
  zones: [{ zip: "10001", trips: 2184, revenue: 29308, avg_fare: 13.42 }],
  queriedAt: "2026-11-14T08:00:00Z",
};
const reply = {
  ...operation,
  text: "The evening has the most pickups in the displayed hours.",
  queries: [
    {
      sql: "SELECT pickup_zip, COUNT(*) AS trips FROM samples.nyctaxi.trips GROUP BY pickup_zip",
      description: "Trips by pickup ZIP",
      columns: ["pickup_zip", "trips"],
      rows: [["10001", "2184"]],
      truncated: true,
    },
  ],
};

async function openHelper(page: Page) {
  await page
    .locator("header")
    .getByRole("button", { name: "Ask Genie", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Genie", exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/metadata", (route) =>
    route.fulfill({
      json: { from: "2016-01-01", to: "2016-02-29", trips: 21932 },
    }),
  );
  await page.route("**/api/trip-map**", (route) =>
    route.fulfill({ json: gpsFixture() }),
  );
  await page.route("**/api/overview**", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/trips**", (route) => {
    const trip = {
      trip_id: "1a2f4670-fcd5-4ac1-9232-2d6b5b91664a",
      pickup_at: "2016-01-11 18:00:00",
      dropoff_at: "2016-01-11 18:14:00",
      pickup_zip: "10001",
      dropoff_zip: "10003",
      distance: 2.8,
      duration: 14,
      fare: 13.42,
    };
    return route.fulfill(tripPreviewResponse([trip], true));
  });
  await page.route("**/api/genie", (route) =>
    route.fulfill({ json: operation }),
  );
  await page.route(messagePath, (route) =>
    route.fulfill({
      json: { ...operation, state: "completed", status: "COMPLETED" },
    }),
  );
  await page.route(`${messagePath}/result`, (route) =>
    route.fulfill({ json: reply }),
  );
});

test("a denied Genie question keeps the chart and its filters available", async ({
  page,
}, testInfo) => {
  const message = "Even Genie needs permission to send this question.";
  await page.route("**/api/genie", (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "permission_denied", message } },
    }),
  );
  await page.goto(`/?${query}`);
  await page
    .getByRole("button", { name: "Ask Genie about trips by pickup date" })
    .click();
  const helper = page.getByRole("dialog", { name: "Genie", exact: true });
  await expect(helper.getByText("Your data, in context")).toHaveCount(0);
  await helper.getByRole("textbox").fill("Which day had the most pickups?");
  await helper
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  await expect(helper.getByRole("alert")).toHaveText(message);
  await expect(
    helper.getByRole("alert").locator('svg[aria-hidden="true"]'),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("genie-permission.png"),
    animations: "disabled",
  });
  await helper.getByRole("button", { name: "Close Genie" }).click();
  await expect(
    page.getByRole("img", { name: "Trips by pickup date" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Pickup ZIP code" }),
  ).toHaveValue(filters.zip);
});

test("explains a selected chart in place with its actual data, filters, SQL, and saved scope", async ({
  page,
}) => {
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/genie", (route) => {
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: operation });
  });
  await page.goto(`/?${query}`);
  const chart = page.locator('[data-slot="tabs"]').filter({
    has: page.getByRole("heading", {
      name: "Trips by pickup date",
      exact: true,
    }),
  });
  const width = (await chart.boundingBox())?.width;
  await chart
    .getByRole("button", {
      name: "Ask Genie about trips by pickup date",
      exact: true,
    })
    .click();
  const helper = page.getByRole("dialog", { name: "Genie", exact: true });
  const scope = helper.getByRole("region", {
    name: "Explore view for your next question",
  });
  await expect(page).toHaveURL(`/?${query}`);
  expect((await chart.boundingBox())?.width).toBe(width);
  await expect(scope).toContainText("Trips by pickup date");
  await expect(scope).toContainText("Pickup ZIP 10001");
  await expect(helper.getByRole("textbox")).toHaveValue(/Explain the pattern/);
  await helper
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  await expect(
    helper.getByRole("cell", { name: "2184", exact: true }),
  ).toBeVisible();
  expect(submissions[0]).toMatchObject({
    filters,
    context: { page: "overview", title: "Trips by pickup date" },
  });
  const context = submissions[0]?.context as { data: string };
  expect(JSON.parse(context.data)).toMatchObject({
    metric: "trips",
    daily: overview.daily,
  });
  await helper.getByRole("button", { name: "Expand Genie" }).click();
  await helper.getByText("View generated SQL", { exact: true }).click();
  await expect(helper.locator("pre")).toContainText("SELECT pickup_zip");
  await expect(helper).toContainText("bounded preview");
  await page.screenshot({
    path: "test-results/genie-helper-expanded.png",
    animations: "disabled",
  });
  await helper.getByRole("button", { name: "Minimize Genie" }).click();
  await page.screenshot({
    path: "test-results/genie-helper-desktop.png",
    animations: "disabled",
  });
  await helper.getByRole("button", { name: "Close Genie" }).click();
  await expect(
    chart.getByRole("button", {
      name: "Ask Genie about trips by pickup date",
      exact: true,
    }),
  ).toBeFocused();
  await openHelper(page);
  await expect(scope).toContainText("Trips by pickup date");
  await helper.getByRole("button", { name: "Close Genie" }).click();
  await expect(helper).toBeHidden();
  await expect(
    page
      .locator("header")
      .getByRole("button", { name: "Ask Genie", exact: true }),
  ).toBeFocused();
  const pickupZip = page.getByRole("textbox", {
    name: "Pickup ZIP code",
    exact: true,
  });
  await pickupZip.fill("10002");
  await expect(pickupZip).toHaveValue("10002");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const updatedFilters = { ...filters, zip: "10002" };
  await expect(page).toHaveURL(`/?${new URLSearchParams(updatedFilters)}`);
  await openHelper(page);
  await expect(scope).toContainText("Trip overview");
  await expect(scope).toContainText("Pickup ZIP 10002");
  await helper
    .getByText("Trips by pickup date · View context", { exact: true })
    .click();
  await expect(
    helper.getByText("Pickup ZIP 10001", { exact: true }),
  ).toBeVisible();
  await helper.getByRole("textbox").fill("Compare fares");
  await helper
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toMatchObject({
    filters: updatedFilters,
    conversationId: "conversation",
    context: { title: "Trip overview" },
  });
});

test("a Records follow-up sends the applied filters after viewing a chart", async ({
  page,
}) => {
  let complete = false;
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/genie", (route) => {
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: operation });
  });
  await page.route(messagePath, (route) =>
    route.fulfill({
      json: {
        ...operation,
        state: complete ? "completed" : "pending",
        status: complete ? "COMPLETED" : "EXECUTING_QUERY",
      },
    }),
  );
  await page.goto(`/?${query}`);
  const helper = await openHelper(page);
  await helper.getByRole("textbox").fill("Explain this view");
  await helper
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  await expect(helper).toContainText("Processing query");
  await helper.getByRole("button", { name: "Close Genie" }).click();
  complete = true;
  await expect
    .poll(() =>
      page.evaluate(() =>
        sessionStorage.getItem("databricks-effect-app.genie.v1"),
      ),
    )
    .toContain('"state":"complete"');
  expect(submissions).toHaveLength(1);
  await page.getByRole("link", { name: "Trip explorer", exact: true }).click();
  await page.getByRole("combobox", { name: "Sort trips" }).selectOption("fare");
  await expect(page).toHaveURL(/sort=fare$/);
  await expect(
    page.getByText("1 shown · more match", { exact: true }),
  ).toBeVisible();
  await openHelper(page);
  const context = helper.getByRole("region", {
    name: "Explore view for your next question",
  });
  await expect(context).toContainText("Trip records");
  await expect(context).toContainText("Applied filters included.");
  await expect(
    helper.getByRole("cell", { name: "2184", exact: true }),
  ).toBeVisible();
  await helper.getByRole("textbox").fill("How many trips match these filters?");
  await helper
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toEqual({
    content: "How many trips match these filters?",
    filters,
    conversationId: "conversation",
  });
  await helper.getByRole("button", { name: "Close Genie" }).click();
  await page.reload();
  await openHelper(page);
  await helper
    .getByText("Trip records · View context", { exact: true })
    .click();
  await expect(
    helper.getByText("Pickup ZIP 10001", { exact: true }).last(),
  ).toBeVisible();
});

test("the page helper and map action send the same filtered geographic coverage", async ({
  page,
}) => {
  let submitted:
    | { context: { page: string; data: string }; filters: unknown }
    | undefined;
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.route("**/api/genie", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: operation });
  });
  await page.goto(`/?${query}`);
  const helper = await openHelper(page);
  await page.getByRole("link", { name: "Trip map", exact: true }).click();
  await expect(page).toHaveURL(`/trip-map?${query}`);
  await expect(helper.getByRole("region")).toContainText("GPS pickups");
  await expect(helper.getByRole("region")).toContainText(
    "Displayed data and applied filters included",
  );
  await helper.getByRole("textbox").fill("Compare these pickup areas");
  await helper
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  await expect.poll(() => submitted?.context.page).toBe("map");
  expect(submitted?.filters).toEqual(filters);
  const pageData = JSON.parse(submitted?.context.data ?? "{}");
  expect(pageData).toMatchObject({
    query: { endpoint: "pickup", filters },
    endpoint: "pickup",
    locatedTrips: 80,
    shownTrips: 80,
    resolution: 10,
  });
  await expect(
    helper.getByRole("cell", { name: "2184", exact: true }),
  ).toBeVisible();
  await helper.getByRole("button", { name: "Close Genie" }).click();
  await page
    .getByRole("button", { name: "Ask Genie about trip hotspots" })
    .click();
  const mapRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/genie",
  );
  await helper
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  const chart = (await mapRequest).postDataJSON();
  expect(chart.filters).toEqual(filters);
  expect(JSON.parse(chart.context.data)).toEqual(pageData);
});

for (const width of [360, 768, 1024]) {
  test(`helper fits ${width}px, preserves drafts, and dismisses with Escape`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/?${query}`);
    const helper = await openHelper(page);
    await expect(helper).toBeInViewport();
    const expand = helper.getByRole("button", {
      name: "Expand Genie",
      exact: true,
    });
    if (width < 768) await expect(expand).toBeHidden();
    else await expect(expand).toBeVisible();
    const textbox = helper.getByRole("textbox");
    await expect(textbox).toBeFocused();
    await textbox.fill("Compare these fares");
    await page.keyboard.press("Escape");
    await expect(helper).not.toBeVisible();
    await expect(
      page
        .locator("header")
        .getByRole("button", { name: "Ask Genie", exact: true }),
    ).toBeFocused();
    await openHelper(page);
    await expect(textbox).toHaveValue("Compare these fares");
    await helper
      .getByRole("button", { name: "Send question", exact: true })
      .click();
    await expect(
      helper.getByRole("cell", { name: "2184", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/genie-helper-${width}.png`,
      animations: "disabled",
    });
  });
}
