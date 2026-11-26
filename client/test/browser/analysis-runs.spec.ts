import { expect, test } from "@playwright/test";

test("a denied report still lets the user reuse the completed run’s inputs", async ({
  page,
}) => {
  const message = "This report is under lock. You need permission to read it.";
  await page.route("**/api/analysis-runs/123", (route) =>
    route.fulfill({
      json: {
        id: 123,
        state: "succeeded",
        requestedBy: "Avery Morgan",
        input: {
          baselineWeek: "2016-01-04",
          comparisonWeek: "2016-01-11",
          minimumTrips: 75,
        },
        startedAt: Date.UTC(2026, 10, 19, 8),
        endedAt: Date.UTC(2026, 10, 19, 8, 1),
        reason: null,
      },
    }),
  );
  await page.route("**/api/analysis-runs/123/result", (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "permission_denied", message } },
    }),
  );
  await page.goto("/analysis?run=123");
  await expect(page.getByRole("alert")).toHaveText(message);
  await expect(
    page.getByRole("alert").locator('svg[aria-hidden="true"]'),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Run #123" })).toBeVisible();
  await expect(
    page.getByText("Minimum trips per week", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("75", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reuse these inputs" }).click();
  const form = page.getByRole("dialog", { name: "New analysis run" });
  await expect(form.getByLabel("Baseline week starts")).toHaveValue(
    "2016-01-04",
  );
  await expect(form.getByLabel("Comparison week starts")).toHaveValue(
    "2016-01-11",
  );
  await expect(form.getByLabel("Minimum trips per week")).toHaveValue("75");
});

test("a status permission denial clears the stale running state", async ({
  page,
}) => {
  const message = "This run is under lock. You need permission to open it.";
  await page.clock.install();
  let allowed = true;
  await page.route("**/api/analysis-runs/123", (route) =>
    route.fulfill(
      allowed
        ? {
            json: {
              id: 123,
              state: "running",
              requestedBy: "Avery Morgan",
              startedAt: null,
              endedAt: null,
              input: null,
              reason: null,
            },
          }
        : {
            status: 403,
            json: { error: { code: "permission_denied", message } },
          },
    ),
  );
  await page.goto("/analysis?run=123");
  const running = page.getByRole("status").filter({ hasText: "Running" });
  await expect(running).toBeVisible();
  allowed = false;
  await page.clock.fastForward("00:30");
  await expect(page.getByRole("alert")).toHaveText(message);
  await expect(running).toBeHidden();
  await expect(page.getByText("Started by Avery Morgan")).toBeHidden();
  allowed = true;
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(running).toBeVisible();
});

test("analysis retries safely and a run link resumes monitoring and reuses inputs", async ({
  page,
}) => {
  const input = {
    baselineWeek: "2016-01-04",
    comparisonWeek: "2016-01-18",
    minimumTrips: 75,
  };
  const submissions: unknown[] = [];
  const startedAt = Date.now() - 15_000;
  let state: "running" | "succeeded" = "running";
  let reportReads = 0;
  const summary = () => ({
    id: 123,
    state,
    requestedBy: "Avery Morgan",
    startedAt,
    endedAt: state === "succeeded" ? startedAt + 15_000 : null,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("**/api/metadata", (route) =>
    route.fulfill({
      json: { from: "2016-01-01", to: "2016-02-29", trips: 10_000 },
    }),
  );
  await page.route("**/api/analysis-runs", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: submissions.length > 1 ? [summary()] : [] });
    }
    submissions.push(route.request().postDataJSON());
    return submissions.length === 1
      ? route.fulfill({
          status: 504,
          json: {
            error: {
              code: "workspace_timeout",
              message: "Databricks request timed out.",
            },
          },
        })
      : route.fulfill({ status: 202, json: { id: 123 } });
  });
  await page.route("**/api/analysis-runs/123", (route) =>
    route.fulfill({ json: { ...summary(), input, reason: null } }),
  );
  await page.route("**/api/analysis-runs/123/result", (route) => {
    reportReads++;
    return route.fulfill({
      json: {
        input,
        rows: [
          {
            pickupZip: "10001",
            dropoffZip: "10002",
            timeBand: "morning",
            baselineCount: 110,
            comparisonCount: 120,
            baselineP90Minutes: 11.5,
            comparisonP90Minutes: 15,
          },
        ],
      },
    });
  });

  await page.goto("/analysis");
  await expect(
    page.getByRole("heading", { name: "Analysis runs" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent runs" }),
  ).toBeVisible();
  await expect(page.getByLabel("Baseline week starts")).toBeHidden();
  await page.getByRole("button", { name: "New run", exact: true }).click();
  const form = page.getByRole("dialog", {
    name: "New analysis run",
    exact: true,
  });
  const baseline = form.getByLabel("Baseline week starts");
  const comparison = form.getByLabel("Comparison week starts");
  const minimum = form.getByLabel("Minimum trips per week");
  await expect(baseline).toHaveAttribute("type", "text");
  await expect(comparison).toHaveAttribute("type", "text");
  await expect(baseline).toHaveValue("");
  await expect(comparison).toHaveValue("");
  const [baselineBox, comparisonBox, minimumBox] = await Promise.all(
    [baseline, comparison, minimum].map((input) => input.boundingBox()),
  );
  if (!baselineBox || !comparisonBox || !minimumBox)
    throw new Error("Cannot measure analysis inputs");
  expect(baselineBox.height).toBeCloseTo(comparisonBox.height, 0);
  expect(baselineBox.height).toBeCloseTo(minimumBox.height, 0);
  expect(comparisonBox.x).toBeGreaterThan(baselineBox.x + baselineBox.width);

  await baseline.fill(input.baselineWeek);
  await page
    .getByRole("button", { name: "Choose comparison week start" })
    .click();
  const calendar = page.getByRole("dialog", {
    name: "Choose comparison week start",
  });
  await calendar.getByRole("button", { name: /January 18, 2016/ }).click();
  await expect(comparison).toHaveValue(input.comparisonWeek);
  await expect(calendar).toBeHidden();
  await minimum.fill(String(input.minimumTrips));
  await page.getByRole("button", { name: "Run analysis", exact: true }).click();
  await expect(page.getByText("Databricks request timed out.")).toBeVisible();
  await page.getByRole("button", { name: "Retry submission" }).click();
  await expect(page).toHaveURL(/\/analysis\?run=123$/);
  await expect(form).toBeHidden();
  await expect(page.getByRole("heading", { name: "Recent runs" })).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: "Running" }),
  ).toBeVisible();
  await expect(
    page.getByText("Started by Avery Morgan", { exact: true }),
  ).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[1]).toMatchObject({ input });
  expect(reportReads).toBe(0);

  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "Running" }),
  ).toBeVisible();
  await expect(
    page.getByText("Started by Avery Morgan", { exact: true }),
  ).toBeVisible();
  state = "succeeded";
  await expect(page.getByRole("cell", { name: "+3.5 min" })).toBeVisible({
    timeout: 10_000,
  });
  expect(
    await page.getByRole("table").evaluate((table) => {
      const container = table.parentElement;
      return container && container.scrollWidth === container.clientWidth;
    }),
  ).toBe(true);
  await expect(page.getByRole("link", { name: "All runs" })).toHaveAttribute(
    "href",
    "/analysis",
  );
  await expect(
    page.getByRole("link", { name: "Analysis runs", exact: true }),
  ).toHaveAttribute("href", "/analysis");
  expect(submissions).toHaveLength(2);
  expect(reportReads).toBe(1);

  const reuse = page.getByRole("button", { name: "Reuse these inputs" });
  const tooltip = page.getByRole("tooltip", {
    name: "Same question, different week?",
  });
  await expect(tooltip).toBeHidden();
  await reuse.focus();
  await expect(tooltip).toBeVisible();
  await expect(reuse).toHaveAccessibleDescription(
    "Same question, different week?",
  );
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await page.getByRole("button", { name: "New run", exact: true }).focus();
  await reuse.hover();
  await expect(tooltip).toBeVisible();
  await reuse.click();
  await expect(baseline).toHaveValue(input.baselineWeek);
  await expect(comparison).toHaveValue(input.comparisonWeek);
  await expect(minimum).toHaveValue(String(input.minimumTrips));
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(reuse).toBeFocused();
  await page.getByRole("button", { name: "New run", exact: true }).click();
  await expect(baseline).toHaveValue("");
  await expect(comparison).toHaveValue("");
  await expect(minimum).toHaveValue("50");
  await page.keyboard.press("Escape");
  await expect(form).toBeHidden();
  expect(submissions).toHaveLength(2);
});

test("a late submission refreshes the reopened history and keeps the user on it", async ({
  page,
}) => {
  const run = {
    id: 123,
    state: "running",
    startedAt: null,
    endedAt: null,
    requestedBy: null,
  };
  let acceptSubmission = () => {};
  const pending = new Promise<void>((resolve) => {
    acceptSubmission = resolve;
  });
  let accepted = false;
  await page.route("**/api/analysis-runs", async (route) => {
    if (route.request().method() === "POST") {
      await pending;
      accepted = true;
      return route.fulfill({ status: 202, json: { id: run.id } });
    }
    return route.fulfill({ json: accepted ? [run] : [] });
  });

  await page.goto("/trips");
  await page.getByRole("link", { name: "Analysis runs", exact: true }).click();
  await page.getByRole("button", { name: "New run", exact: true }).click();
  await page.getByLabel("Baseline week starts").fill("2016-01-04");
  await page.getByLabel("Comparison week starts").fill("2016-01-11");
  await Promise.all([
    page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/analysis-runs" &&
        request.method() === "POST",
    ),
    page.getByRole("button", { name: "Run analysis", exact: true }).click(),
  ]);
  await page.goBack();
  await expect(page).toHaveURL("/trips");
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Recent runs" }),
  ).toBeVisible();

  acceptSubmission();
  await expect(page.getByRole("link", { name: /Run #123/ })).toBeVisible();
  await expect(page).toHaveURL("/analysis");
});

test("a phone can return from the end of a long report and reopen it from history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const input = {
    baselineWeek: "2016-01-04",
    comparisonWeek: "2016-01-11",
    minimumTrips: 20,
  };
  const summary = {
    id: 321,
    state: "succeeded",
    requestedBy: "Avery Morgan",
    startedAt: Date.UTC(2026, 0, 20),
    endedAt: Date.UTC(2026, 0, 20, 0, 1),
  };
  await page.route("**/api/analysis-runs", (route) =>
    route.fulfill({ json: [summary] }),
  );
  await page.route("**/api/analysis-runs/321", (route) =>
    route.fulfill({ json: { ...summary, input, reason: null } }),
  );
  await page.route("**/api/analysis-runs/321/result", (route) =>
    route.fulfill({
      json: {
        input,
        rows: Array.from({ length: 50 }, (_, i) => ({
          pickupZip: String(10001 + i),
          dropoffZip: "10010",
          timeBand: "morning",
          baselineCount: 35,
          comparisonCount: 41,
          baselineP90Minutes: 12,
          comparisonP90Minutes: 14,
        })),
      },
    }),
  );

  await page.goto("/analysis?zip=10001&run=321");
  const history = page.getByRole("link", { name: "All runs" });
  const last = page.getByRole("cell", { name: /10050.*10010/ });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(history).toBeInViewport();
  await expect(history).toHaveAttribute("href", "/analysis?zip=10001");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await history.click();
  await expect(page).toHaveURL("/analysis?zip=10001");
  const entry = page.getByRole("link", { name: /Run #321/ });
  await expect(entry).toHaveAttribute("href", "/analysis?zip=10001&run=321");
  await expect(page.getByRole("cell", { name: /10050.*10010/ })).toBeHidden();
  await entry.focus();
  await entry.press("Enter");
  const heading = page.getByRole("heading", { name: "Run #321" });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await page.getByRole("button", { name: "New run", exact: true }).click();
  const form = page.getByRole("dialog", {
    name: "New analysis run",
    exact: true,
  });
  await expect(form).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/analysis?zip=10001");
  await expect(form).toBeHidden();
  await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
  await expect(entry).toBeVisible();
});
