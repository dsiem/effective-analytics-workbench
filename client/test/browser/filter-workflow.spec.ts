import { expect, test } from "@playwright/test";

for (const width of [360, 768, 1024, 1440]) {
  for (const populated of [false, true]) {
    test(`filter controls stay within their fields at ${width}px (${populated ? "populated" : "empty"})`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/metadata", (route) =>
        route.fulfill({
          json: { from: "2016-01-01", to: "2016-02-29", trips: 100 },
        }),
      );
      await page.goto(
        `/trips${populated ? "?from=2016-01-10&to=2016-02-20&zip=10001" : ""}`,
      );
      const form = page.getByRole("form", {
        name: "Filters",
        exact: true,
      });
      await expect(form.getByLabel("Pickup start date")).toBeVisible();
      const fields = await form.locator(".field").evaluateAll((elements) =>
        elements.map((field) => {
          const input = field.querySelector("input");
          const outer = field.getBoundingClientRect();
          const inner = input?.getBoundingClientRect();
          return {
            label: field.querySelector("label")?.textContent,
            left: outer.left,
            right: outer.right,
            inputLeft: inner?.left ?? 0,
            inputRight: inner?.right ?? 0,
            inputWidth: inner?.width ?? 0,
          };
        }),
      );
      await page.screenshot({
        path: info.outputPath("filters.png"),
        animations: "disabled",
      });
      await form.screenshot({
        path: info.outputPath("filter-panel.png"),
        animations: "disabled",
      });
      for (const field of fields) {
        expect(field.inputLeft, JSON.stringify(field)).toBeGreaterThanOrEqual(
          field.left - 1,
        );
        expect(field.inputRight, JSON.stringify(field)).toBeLessThanOrEqual(
          field.right + 1,
        );
        expect(field.inputWidth).toBeGreaterThan(80);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
}

const airportView = {
  id: "8aa0cc1a-6033-4fd0-9a61-908958570382",
  title: "Airport pickups",
  body: "Review January airport trips.",
  filters: { from: "2016-01-10", to: "2016-01-20", zip: "11430" },
  version: 1,
  pinned: true,
  created_at: "2026-11-14T10:00:00Z",
  updated_at: "2026-11-14T10:00:00Z",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/trips**", (route) =>
    route.fulfill({
      json: { rows: [], total: 0, pageSize: 25, nextCursor: null },
    }),
  );
  await page.route("**/api/metadata", (route) =>
    route.fulfill({
      json: { from: "2016-01-01", to: "2016-02-29", trips: 100 },
    }),
  );
  await page.route("**/api/saved-views**", (route) =>
    route.fulfill({ json: { rows: [airportView], nextCursor: null } }),
  );
});

test("browser history closes the Saved Views picker when it leaves Explore", async ({
  page,
}) => {
  await page.route("**/api/analysis-runs", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/analysis");
  await page.getByRole("link", { name: "Trip explorer", exact: true }).click();
  const trigger = page.getByRole("button", {
    name: "Saved views",
    exact: true,
  });
  const picker = page.getByRole("dialog", { name: "Saved views", exact: true });
  await trigger.click();
  await expect(picker).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("overflow", "hidden");

  await page.goBack();
  await expect(page).toHaveURL("/analysis");
  await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
  await expect(
    page.getByRole("heading", { name: "Analysis runs", exact: true }),
  ).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL("/trips");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(picker).not.toBeVisible();
});

test("pending edits must be applied before saving and the saved view keeps those values", async ({
  page,
}) => {
  let submitted: unknown;
  await page.route("**/api/saved-views", (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({ json: { rows: [airportView], nextCursor: null } });
    submitted = route.request().postDataJSON();
    return route.fulfill({
      json: { ...airportView, ...route.request().postDataJSON(), version: 1 },
    });
  });
  await page.goto("/trips?zip=10001");
  const form = page.getByRole("form", { name: "Filters" });
  await expect(
    form.getByRole("button", { name: "Apply", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Pickup ZIP code").fill("10002");
  await expect(form.getByRole("status")).toContainText("Unapplied changes");
  await expect(form.getByRole("status")).toContainText("Pickup ZIP 10001");
  await expect(
    form.getByRole("button", { name: "Save view", exact: true }),
  ).toBeDisabled();
  await form.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL("/trips?zip=10002");
  await form.getByRole("button", { name: "Save view", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "What would you call this view?",
    exact: true,
  });
  await editor.getByLabel("View name", { exact: true }).fill("Fare review");
  await editor.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(submitted).toMatchObject({
    title: "Fare review",
    filters: { zip: "10002" },
  });
  await expect(
    form.getByRole("button", { name: "Saved views", exact: true }),
  ).toContainText("Fare review");
});

test("opening a saved view applies its filters in place and identifies the active view", async ({
  page,
}, info) => {
  await page.goto("/trips?zip=10001");
  const trigger = page.getByRole("button", {
    name: "Saved views",
    exact: true,
  });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Saved views", exact: true });
  const option = picker.getByRole("button", {
    name: "Open saved view for Airport pickups",
    exact: true,
  });
  await expect(option).toBeVisible();
  await page.screenshot({
    path: info.outputPath("view-chooser.png"),
    animations: "disabled",
  });
  await option.click();
  await expect(picker).not.toBeVisible();
  await expect(page).toHaveURL(
    "/trips?from=2016-01-10&to=2016-01-20&zip=11430",
  );
  await expect(page.getByLabel("Pickup start date")).toHaveValue("2016-01-10");
  await expect(page.getByLabel("Pickup end date")).toHaveValue("2016-01-20");
  await expect(page.getByLabel("Pickup ZIP code")).toHaveValue("11430");
  await expect(trigger).toContainText("Airport pickups");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(option).toContainText("Applied");
  await picker
    .getByRole("button", { name: "Show all trips", exact: true })
    .click();
  await expect(page).toHaveURL("/trips");
  await expect(trigger).toContainText("All trips");
});

test("opening an already-applied view discards unapplied edits even when its URL is unchanged", async ({
  page,
}) => {
  await page.goto("/trips?from=2016-01-10&to=2016-01-20&zip=11430");
  await page.getByLabel("Pickup ZIP code").fill("10002");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Open saved view for Airport pickups",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Pickup ZIP code")).toHaveValue("11430");
  await expect(
    page.getByText("Unapplied changes", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page
      .getByRole("form", { name: "Filters" })
      .getByRole("button", { name: "Save view", exact: true }),
  ).toBeEnabled();
});

test("reset clears a draft even when no filters have been applied", async ({
  page,
}) => {
  await page.goto("/trips");
  await page.getByLabel("Pickup ZIP code").fill("10002");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByLabel("Pickup ZIP code")).toHaveValue("");
  await expect(
    page.getByText("Unapplied changes", { exact: true }),
  ).not.toBeVisible();
  await expect(page).toHaveURL("/trips");
});

test("view chooser supports keyboard dismissal and returns focus to its trigger", async ({
  page,
}) => {
  await page.goto("/trips");
  const trigger = page.getByRole("button", {
    name: "Saved views",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const picker = page.getByRole("dialog", { name: "Saved views", exact: true });
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("saved view management returns to the chooser after editing and deletion", async ({
  page,
}) => {
  let views = [airportView];
  await page.route("**/api/saved-views**", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const saved = { ...airportView, ...request.postDataJSON(), version: 2 };
      views = [saved];
      return route.fulfill({ json: saved });
    }
    if (request.method() === "DELETE") {
      views = [];
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({ json: { rows: views, nextCursor: null } });
  });
  await page.goto("/trips?from=2016-01-10&to=2016-01-20&zip=11430");
  const trigger = page.getByRole("button", {
    name: "Saved views",
    exact: true,
  });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Saved views", exact: true });
  await picker
    .getByRole("button", { name: "Edit Airport pickups", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Edit saved view",
    exact: true,
  });
  await editor
    .getByLabel("View name", { exact: true })
    .fill("Airport fare review");
  await editor.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(picker).toBeVisible();
  await expect(trigger).toContainText("Airport fare review");
  await picker
    .getByRole("button", { name: "Delete Airport fare review", exact: true })
    .click();
  const deletion = page.getByRole("dialog", {
    name: "Delete this saved view?",
    exact: true,
  });
  await deletion
    .getByRole("button", { name: "Delete view", exact: true })
    .click();
  await expect(deletion).not.toBeVisible();
  await expect(
    picker.getByRole("heading", { name: "No saved views", exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByRole("searchbox", { name: "Search all saved views" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText("Custom view");
});

test("loading more views preserves keyboard focus and returns it to the chooser at the end", async ({
  page,
}) => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const second = {
    ...airportView,
    id: "57b7651d-c553-4fcf-815d-104cc57fd745",
    title: "City pickups",
  };
  await page.route("**/api/saved-views**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      await pending;
      return route.fulfill({ json: { rows: [second], nextCursor: null } });
    }
    return route.fulfill({
      json: {
        rows: [airportView],
        nextCursor: {
          id: airportView.id,
          pinned: true,
          updatedAt: "2026-11-14T10:00:00.000000Z",
        },
      },
    });
  });
  await page.goto("/trips");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Saved views", exact: true });
  const more = picker.getByRole("button", {
    name: "Load more views",
    exact: true,
  });
  await expect(
    picker.getByRole("searchbox", { name: "Search all saved views" }),
  ).toBeFocused();
  await picker
    .getByRole("button", { name: "Browse all views", exact: true })
    .click();
  await expect(more).toBeVisible();
  await more.focus();
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  const loading = picker.getByRole("button", {
    name: "Loading views…",
    exact: true,
  });
  await expect(loading).toBeFocused();
  await expect(loading).toHaveAttribute("aria-busy", "true");
  release();
  await expect(
    picker.getByRole("button", {
      name: "Open saved view for City pickups",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    picker.getByRole("searchbox", { name: "Search all saved views" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
});

test("the desktop sidebar stays hidden on mobile before viewport detection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.addInitScript(() => {
    const desktop = matchMedia("(max-width: 0px)");
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      query === "(max-width: 767px)" ? desktop : original(query);
  });
  await page.goto("/trips?from=2016-01-10&to=2016-02-20&zip=10001");

  const sidebar = page.locator(".workspace > .sidebar");
  await expect(sidebar).toBeAttached();
  await expect(sidebar).toBeHidden();
  await expect(page.getByLabel("Pickup start date")).toBeVisible();
});
