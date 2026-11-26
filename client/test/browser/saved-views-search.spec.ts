import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type {
  SavedView,
  SavedViewCursor,
} from "@dsiem/analytics-shared/saved-views";

const storageKey = "taxi.recent-saved-views";
const makeViews = (): SavedView[] =>
  Array.from({ length: 1000 }, (_, index) => ({
    id: randomUUID(),
    title: `Finding ${index + 1}`,
    body: "Saved analysis",
    filters: { zip: "10001", from: "2016-01-01", to: "2016-01-31" },
    pinned: index < 3,
    version: 1,
    created_at: new Date(
      Date.UTC(2026, 0, 1, 0, 0, 1000 - index),
    ).toISOString(),
    updated_at: new Date(
      Date.UTC(2026, 0, 1, 0, 0, 1000 - index),
    ).toISOString(),
  }));
function viewAt(rows: readonly SavedView[], index: number) {
  const row = rows[index];
  assert.ok(row, "Missing fixture view");
  return row;
}
const cursorFor = (row: SavedView): SavedViewCursor => ({
  id: row.id,
  pinned: row.pinned,
  updatedAt: row.updated_at.replace("Z", "000Z"),
});
const picker = (page: Page) =>
  page.getByRole("dialog", { name: "Saved views", exact: true });
const openPicker = async (page: Page) => {
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await expect(picker(page).getByRole("searchbox")).toBeFocused();
};
async function fixture(page: Page, getRows: () => SavedView[]) {
  await page.route("**/api/saved-views**", async (route) => {
    const url = new URL(route.request().url());
    const tokens = (url.searchParams.get("q") ?? "")
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const ids: unknown = url.searchParams.has("ids")
      ? JSON.parse(url.searchParams.get("ids") ?? "[]")
      : null;
    const matches = getRows().filter(
      (row) =>
        (!Array.isArray(ids) || ids.includes(row.id)) &&
        tokens.every((token) =>
          `${row.title} ${row.body} ${row.filters.from} ${row.filters.to} ${row.filters.zip}`
            .toLowerCase()
            .includes(token),
        ),
    );
    const rawCursor = url.searchParams.get("cursor");
    const cursor: unknown = rawCursor ? JSON.parse(rawCursor) : null;
    const cursorId =
      cursor && typeof cursor === "object" && "id" in cursor ? cursor.id : null;
    const start = cursorId
      ? matches.findIndex((row) => row.id === cursorId) + 1
      : 0;
    const rows = matches.slice(start, start + 24);
    const last = rows.at(-1);
    await route.fulfill({
      json: {
        rows,
        nextCursor:
          last && start + rows.length < matches.length ? cursorFor(last) : null,
      },
    });
  });
}

test("the picker can replace a pending search and open the new result by keyboard", async ({
  page,
}) => {
  const rows = makeViews();
  const target = {
    ...viewAt(rows, 999),
    title: "JFK winter exceptions",
    body: "Follow up flight delays",
    filters: { zip: "11430", from: "2016-02-01", to: "2016-02-29" },
  };
  rows[999] = target;
  await fixture(page, () => rows);
  await page.goto("/trips");
  await openPicker(page);
  const views = picker(page);
  await expect(
    views.getByRole("heading", { name: "Pinned", exact: true }),
  ).toBeVisible();
  expect(
    await views.getByRole("button", { name: /^Open saved view for/ }).count(),
  ).toBeLessThanOrEqual(10);
  const search = views.getByRole("searchbox", {
    name: "Search all saved views",
  });
  const firstSearch = (url: URL) =>
    url.pathname === "/api/saved-views" &&
    url.searchParams.get("q") === "Finding";
  await page.route(firstSearch, () => {
    // Leave the first request pending while the user changes the search.
  });
  await Promise.all([
    page.waitForRequest((request) => firstSearch(new URL(request.url()))),
    search.fill("Finding"),
  ]);
  await search.fill("flight delays");
  const targetButton = views.getByRole("button", {
    name: "Open saved view for JFK winter exceptions",
    exact: true,
  });
  await expect(targetButton).toBeVisible();
  await expect(
    views.getByRole("button", { name: /^Open saved view for/ }),
  ).toHaveCount(1);
  await expect(targetButton).toContainText("Pickup ZIP 11430");
  await expect(search).toHaveAttribute("aria-busy", "false");
  await search.press("ArrowDown");
  await expect(targetButton).toBeFocused();
  await targetButton.press("ArrowUp");
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  await targetButton.press("Enter");
  await expect(views).not.toBeVisible();
  await expect(page).toHaveURL(/from=2016-02-01&to=2016-02-29&zip=11430/);
  await expect(
    page.getByRole("button", { name: "Saved views", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBe(JSON.stringify([target.id]));
  await openPicker(page);
  await expect(
    views.getByRole("heading", { name: "Recently used", exact: true }),
  ).toBeVisible();
  await expect(targetButton).toHaveCount(1);
  await search.fill("Other finding");
  await search.press("Escape");
  await expect(views).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Saved views", exact: true }),
  ).toBeFocused();
  await openPicker(page);
  await expect(search).toHaveValue("");
  await expect(
    views.getByRole("heading", { name: "Pinned", exact: true }),
  ).toBeVisible();
});

test("personal recents hydrate fresh records, deduplicate pins and discard deleted IDs across reload", async ({
  page,
}) => {
  let rows = makeViews();
  const target = viewAt(rows, 999);
  const pinned = viewAt(rows, 0);
  const missing = randomUUID();
  await fixture(page, () => rows);
  await page.goto("/trips");
  await page.evaluate(
    ({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids)),
    { key: storageKey, ids: [target.id, pinned.id, missing] },
  );
  await openPicker(page);
  await expect(
    picker(page).getByRole("button", {
      name: "Open saved view for Finding 1",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    picker(page).getByRole("button", {
      name: "Open saved view for Finding 1000",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBe(JSON.stringify([target.id, pinned.id]));
  await picker(page).getByRole("searchbox").press("Escape");
  rows = rows.map((row) =>
    row.id === target.id
      ? {
          ...row,
          title: "Renamed by teammate",
          filters: { zip: "10019" },
          version: 2,
        }
      : row,
  );
  await page.reload();
  await openPicker(page);
  await picker(page)
    .getByRole("button", {
      name: "Open saved view for Renamed by teammate",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/zip=10019/);
  rows = rows.filter((row) => row.id !== target.id);
  await openPicker(page);
  await expect(
    picker(page).getByRole("button", {
      name: "Open saved view for Renamed by teammate",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBe(JSON.stringify([pinned.id]));
});

test("pinning and applying before recent hydration finishes preserves older recent IDs", async ({
  page,
}) => {
  const rows = makeViews();
  const previous = viewAt(rows, 700);
  let target = { ...viewAt(rows, 999), title: "Airport exception review" };
  rows[999] = target;
  await fixture(page, () => rows);
  let release: (() => void) | undefined;
  let requested: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/saved-views**", async (route) => {
    const ids = new URL(route.request().url()).searchParams.get("ids");
    if (!ids) return route.fallback();
    requested?.();
    await gate;
    return route.fallback();
  });
  await page.route(`**/api/saved-views/${target.id}/pin`, (route) => {
    target = { ...target, pinned: true, version: 2 };
    rows[999] = target;
    return route.fulfill({ json: target });
  });
  await page.goto("/trips");
  await page.evaluate(
    ({ key, id }) => localStorage.setItem(key, JSON.stringify([id])),
    { key: storageKey, id: previous.id },
  );
  await openPicker(page);
  await started;
  const search = picker(page).getByRole("searchbox");
  await search.fill("Airport exception review");
  await picker(page)
    .getByRole("button", { name: "Pin Airport exception review", exact: true })
    .click();
  await expect(
    picker(page).getByRole("button", {
      name: "Unpin Airport exception review",
      exact: true,
    }),
  ).toBeVisible();
  await expect(search).toBeFocused();
  await search.press("Enter");
  await expect(picker(page)).not.toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBe(JSON.stringify([target.id, previous.id]));
  release?.();
  await openPicker(page);
  await expect(
    picker(page).getByRole("heading", { name: "Recently used", exact: true }),
  ).toBeVisible();
  await expect(
    picker(page).getByRole("button", {
      name: `Open saved view for ${previous.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBe(JSON.stringify([target.id, previous.id]));
});

test("same-name views expose different dates, remain selectable on mobile, and recover from no matches", async ({
  page,
}) => {
  const rows = makeViews();
  rows[998] = {
    ...viewAt(rows, 998),
    title: "Midtown review",
    filters: { zip: "10001", from: "2016-01-01", to: "2016-01-07" },
  };
  rows[999] = {
    ...viewAt(rows, 999),
    title: "Midtown review",
    filters: { zip: "10001", from: "2016-01-08", to: "2016-01-14" },
  };
  await fixture(page, () => rows);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/trips");
  await openPicker(page);
  const search = picker(page).getByRole("searchbox");
  await search.fill("no-such-view");
  await expect(
    picker(page).getByRole("heading", {
      name: "No matching views",
      exact: true,
    }),
  ).toBeVisible();
  await picker(page)
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await search.fill("Midtown review");
  const matches = picker(page).getByRole("button", {
    name: "Open saved view for Midtown review",
    exact: true,
  });
  await expect(matches).toHaveCount(2);
  const firstDates = "Jan 1, 2016 – Jan 7, 2016";
  const secondDates = "Jan 8, 2016 – Jan 14, 2016";
  const first = matches.filter({ hasText: firstDates });
  const second = matches.filter({ hasText: secondDates });
  await expect(first.getByText(firstDates, { exact: true })).toBeVisible();
  await expect(first).toHaveAccessibleDescription(new RegExp(firstDates));
  await expect(second.getByText(secondDates, { exact: true })).toBeVisible();
  await expect(second).toHaveAccessibleDescription(new RegExp(secondDates));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await second.click();
  await expect(page).toHaveURL(
    "/trips?from=2016-01-08&to=2016-01-14&zip=10001",
  );
});
