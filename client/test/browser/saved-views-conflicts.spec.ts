import { expect, test } from "@playwright/test";
import type { SavedView } from "@dsiem/analytics-shared/saved-views";

const original: SavedView = {
  id: "472a6613-2337-4af1-a416-e9b6b61064dd",
  title: "Shared finding",
  body: "Original body",
  filters: { zip: "10001" },
  pinned: false,
  version: 1,
  created_at: "2026-11-13T10:00:00Z",
  updated_at: "2026-11-13T10:00:00Z",
};

for (const removed of [false, true]) {
  test(`a ${removed ? "deleted" : "changed"} saved view rejects a stale draft and keeps it in the editor`, async ({
    page,
  }) => {
    let current: SavedView | null = original;
    let submitted: unknown;
    let releaseSave = () => {};
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route("**/api/saved-views", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: { rows: current ? [current] : [], nextCursor: null },
        });
      submitted = route.request().postDataJSON();
      await pendingSave;
      return route.fulfill({
        status: removed ? 404 : 409,
        json: {
          error: {
            code: removed ? "saved_view_not_found" : "saved_view_conflict",
            message: removed
              ? "This saved view has been removed."
              : "This saved view changed since you opened it. Close and reopen it to load the latest version before trying again.",
          },
        },
      });
    });
    await page.goto("/trips");
    await page
      .getByRole("button", { name: "Saved views", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit Shared finding", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Edit saved view" });
    await dialog
      .getByRole("textbox", { name: "Finding (optional)" })
      .fill("My unsaved draft");
    current = removed
      ? null
      : { ...original, body: "Another editor's content", version: 2 };
    await dialog
      .getByRole("button", { name: "Save view", exact: true })
      .click();
    const title = dialog.getByRole("textbox", { name: "View name" });
    const finding = dialog.getByRole("textbox", { name: "Finding (optional)" });
    try {
      await expect(title).not.toBeEditable();
      await expect(finding).not.toBeEditable();
    } finally {
      releaseSave();
    }
    await expect(dialog.getByRole("alert")).toContainText(
      removed ? "removed" : "changed",
    );
    await expect(title).toBeEditable();
    await expect(finding).toBeEditable();
    await expect(finding).toHaveValue("My unsaved draft");
    expect(submitted).toEqual({
      id: original.id,
      title: original.title,
      body: "My unsaved draft",
      filters: original.filters,
      version: 1,
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    if (!removed) {
      await page
        .getByRole("button", { name: "Edit Shared finding", exact: true })
        .click();
      await expect(
        dialog.getByRole("textbox", { name: "Finding (optional)" }),
      ).toHaveValue("Another editor's content");
    } else {
      await expect(
        page.getByRole("heading", { name: "No saved views" }),
      ).toBeVisible();
    }
  });
}

test("pinning sends only the pin and version, preserving newer saved view content", async ({
  page,
}) => {
  let current = original;
  let payload: unknown;
  await page.route("**/api/saved-views", (route) =>
    route.fulfill({ json: { rows: [current], nextCursor: null } }),
  );
  await page.route(`**/api/saved-views/${original.id}/pin`, (route) => {
    expect(route.request().method()).toBe("PATCH");
    payload = route.request().postDataJSON();
    current = { ...current, pinned: true, version: 2 };
    return route.fulfill({ json: current });
  });
  await page.goto("/trips");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page
    .getByRole("button", { name: "Pin Shared finding", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unpin Shared finding", exact: true }),
  ).toBeVisible();
  expect(payload).toEqual({ pinned: true, version: 1 });
  await expect(page.getByText(original.body, { exact: true })).toBeVisible();
});
