import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type {
  SavedView,
  SavedViewCursor,
} from "@dsiem/analytics-shared/saved-views";

const makeSavedViews = (count: number): SavedView[] =>
  Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    title: `Finding ${index + 1}`,
    body: "Saved analysis",
    filters: { zip: "10001" },
    pinned: false,
    version: 1,
    created_at: new Date(
      Date.UTC(2026, 0, 1, 0, 0, count - index),
    ).toISOString(),
    updated_at: new Date(
      Date.UTC(2026, 0, 1, 0, 0, count - index),
    ).toISOString(),
  }));

const cursorFor = (savedView: SavedView): SavedViewCursor => ({
  id: savedView.id,
  pinned: savedView.pinned,
  updatedAt: savedView.updated_at.replace("Z", "000Z"),
});

test("all saved views remain reachable beyond 200 and pinning a later saved view refreshes the loaded pages", async ({
  page,
}) => {
  let saved = makeSavedViews(201);
  await page.route("**/api/saved-views**", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "PATCH") {
      const id = url.pathname.split("/").at(-2);
      const savedView = saved.find((entry) => entry.id === id);
      expect(savedView).toBeDefined();
      if (!savedView) throw new Error("Missing fixture saved view");
      const updated = {
        ...savedView,
        ...route.request().postDataJSON(),
        version: savedView.version + 1,
      };
      saved = [updated, ...saved.filter((entry) => entry.id !== id)];
      return route.fulfill({ json: updated });
    }
    const cursor = url.searchParams.get("cursor");
    const start = cursor
      ? saved.findIndex(
          (savedView) =>
            savedView.id === (JSON.parse(cursor) as SavedViewCursor).id,
        ) + 1
      : 0;
    const rows = saved.slice(start, start + 24);
    const last = rows.at(-1);
    return route.fulfill({
      json: {
        rows,
        nextCursor:
          start + rows.length < saved.length && last ? cursorFor(last) : null,
      },
    });
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/trips?zip=10001");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const headings = page.getByRole("button", {
    name: /^Open saved view for Finding /,
  });
  await page
    .getByRole("button", { name: "Browse all views", exact: true })
    .click();
  await expect(headings).toHaveCount(24);
  const more = page.getByRole("button", {
    name: "Load more views",
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/saved-views-pagination-load-more-mobile.png",
    animations: "disabled",
  });
  for (let shown = 24; shown < 201;) {
    await more.click();
    shown = Math.min(shown + 24, 201);
    await expect(headings).toHaveCount(shown);
  }
  await expect(more).not.toBeVisible();
  await expect(
    page.getByText("201 saved views shown", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pin Finding 201", exact: true })
    .click();
  await expect(headings.first()).toHaveAccessibleName(
    "Open saved view for Finding 201",
  );
  await expect(headings).toHaveCount(201);
  await expect(
    page.getByRole("button", {
      name: "Open saved view for Finding 201",
      exact: true,
    }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Edit Finding 201", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Edit saved view" }),
  ).toContainText("Pickup ZIP 10001");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit saved view" }),
  ).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/saved-views-pagination-mobile.png",
    animations: "disabled",
  });
});

test("a failed next page keeps existing saved views visible and can be retried", async ({
  page,
}) => {
  const saved = makeSavedViews(25);
  const boundary = saved[23];
  if (!boundary) throw new Error("Missing fixture saved view");
  let failing = true;
  await page.route("**/api/saved-views**", (route) => {
    const next = new URL(route.request().url()).searchParams.has("cursor");
    if (next && failing)
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "lakebase_unavailable",
            message: "Saved views are temporarily unavailable.",
          },
        },
      });
    return route.fulfill({
      json: {
        rows: next ? saved.slice(24) : saved.slice(0, 24),
        nextCursor: next ? null : cursorFor(boundary),
      },
    });
  });
  await page.goto("/trips");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  const headings = page.getByRole("button", {
    name: /^Open saved view for Finding /,
  });
  await page
    .getByRole("button", { name: "Browse all views", exact: true })
    .click();
  await expect(headings).toHaveCount(24);
  await page.getByRole("button", { name: "Load more views" }).click();
  const views = page.getByRole("dialog", { name: "Saved views", exact: true });
  await expect(views.getByRole("alert")).toHaveText(
    "Saved views are temporarily unavailable.",
  );
  await expect(headings).toHaveCount(24);
  failing = false;
  await page.getByRole("button", { name: "Retry loading views" }).click();
  await expect(headings).toHaveCount(25);
  await expect(views.getByRole("alert")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more views" }),
  ).not.toBeVisible();
});
