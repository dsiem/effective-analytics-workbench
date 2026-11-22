import assert from "node:assert/strict";
import test from "node:test";
import { Popover } from "@foldkit/ui";
import type { SavedView, SavedViewsPage } from "../../shared/saved-views";
import { Message as M } from "../src/features/saved-views/messages";
import { init as initBrowser } from "../src/features/saved-views/browser-model";
import {
  refreshBrowser,
  updateBrowser,
} from "../src/features/saved-views/browser-update";
import { init } from "../src/features/saved-views/model";
import {
  rememberRecent,
  visibleSavedViews,
} from "../src/features/saved-views/picker";
import { updateSavedViews as update } from "../src/features/saved-views/update";

const context = { filters: {} };
const row = (index: number): SavedView => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  title: `View ${index}`,
  body: "Finding",
  filters: { zip: "10001" },
  version: 1,
  pinned: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});
const opened = () =>
  update(
    init(),
    M.SavedViewsPicker({ message: Popover.Message.RequestedOpen() }),
    context,
  ).model;
const openedBrowser = () =>
  updateBrowser(
    initBrowser(),
    M.SavedViewsPicker({ message: Popover.Message.RequestedOpen() }),
  ).model;
const result = (
  version: number,
  rows: SavedView[],
  more = false,
  nextCursor: SavedViewsPage["nextCursor"] = null,
) =>
  M.LoadedSavedViews({
    version,
    data: { rows, nextCursor },
    error: "",
    more,
    pages: 1,
  });

test("a replaced search cannot start from an old cancellation or accept an old response", () => {
  const first = updateBrowser(
    openedBrowser(),
    M.SavedViewSearchChanged({ value: "first" }),
  ).model;
  const latest = updateBrowser(
    first,
    M.SavedViewSearchChanged({ value: "latest" }),
  ).model;
  const staleCancel = updateBrowser(
    latest,
    M.CompletedCancelLoadSavedViews({
      version: first.searchVersion,
      more: false,
      debounce: true,
    }),
  );
  assert.equal(staleCancel.commands?.length ?? 0, 0);
  const staleResponse = updateBrowser(
    latest,
    result(first.searchVersion, [row(1)]),
  ).model;
  assert.deepEqual(visibleSavedViews(staleResponse), []);
  const current = updateBrowser(
    staleResponse,
    result(latest.searchVersion, [row(2)]),
  ).model;
  assert.deepEqual(
    visibleSavedViews(current).map((entry) => entry.title),
    ["View 2"],
  );
});

test("closing and reopening cannot accept a previous session's search or shortcut hydration", () => {
  const first = updateBrowser(
    openedBrowser(),
    M.SavedViewSearchChanged({ value: "first" }),
  ).model;
  const closed = updateBrowser(
    first,
    M.SavedViewsPicker({ message: Popover.Message.RequestedClose() }),
  ).model;
  const reopened = updateBrowser(
    closed,
    M.SavedViewsPicker({ message: Popover.Message.RequestedOpen() }),
  ).model;
  const late = updateBrowser(
    reopened,
    result(first.searchVersion, [row(1)]),
  ).model;
  const hydrated = updateBrowser(
    late,
    M.LoadedSavedViewShortcuts({
      version: first.shortcutVersion,
      data: { rows: [row(1)], recents: [row(1)] },
      recentIds: [row(1).id],
      error: "",
    }),
  ).model;
  assert.deepEqual(visibleSavedViews(hydrated), []);
  assert.deepEqual(hydrated.recentIds, []);
});

test("a failed continuation keeps results and its retry cursor, and a successful retry deduplicates IDs", () => {
  const searching = updateBrowser(openedBrowser(), M.BrowseSavedViews()).model;
  const cursor = {
    id: row(1).id,
    pinned: false,
    updatedAt: "2026-01-01T00:00:00.000000Z",
  };
  const first = updateBrowser(
    searching,
    result(searching.searchVersion, [row(1)], false, cursor),
  ).model;
  const pending = updateBrowser(first, M.LoadSavedViews({ more: true })).model;
  const duplicate = updateBrowser(pending, M.LoadSavedViews({ more: true }));
  assert.equal(duplicate.commands?.length ?? 0, 0);
  const failed = updateBrowser(
    pending,
    M.LoadedSavedViews({
      version: pending.searchVersion,
      data: null,
      error: "Try again",
      more: true,
      pages: 1,
    }),
  ).model;
  assert.deepEqual(
    visibleSavedViews(failed).map((entry) => entry.id),
    [row(1).id],
  );
  assert.deepEqual(failed.savedViews.data?.nextCursor, cursor);
  const retry = updateBrowser(failed, M.LoadSavedViews({ more: true })).model;
  const loaded = updateBrowser(
    retry,
    result(retry.searchVersion, [row(1), row(2)], true),
  ).model;
  assert.deepEqual(
    visibleSavedViews(loaded).map((entry) => entry.id),
    [row(1).id, row(2).id],
  );
});

test("applying a view promotes only its ID and invalidates pending recent hydration", () => {
  const model = opened();
  const applied = update(
    { ...model, browser: { ...model.browser, recentIds: [row(1).id] } },
    M.RestoreView({ savedView: row(2) }),
    context,
  );
  assert.deepEqual(applied.model.browser.recentIds, [row(2).id, row(1).id]);
  assert.deepEqual(applied.outMessage, {
    _tag: "RestoreFilters",
    filters: row(2).filters,
  });
  const late = update(
    applied.model,
    M.LoadedSavedViewShortcuts({
      version: model.browser.shortcutVersion,
      data: { rows: [row(1)], recents: [row(1)] },
      recentIds: [row(1).id],
      error: "",
    }),
    context,
  );
  assert.deepEqual(late.model.browser.recentIds, [row(2).id, row(1).id]);
  assert.deepEqual(rememberRecent(["1", "2", "3", "4", "5"], "3"), [
    "3",
    "1",
    "2",
    "4",
    "5",
  ]);
});

test("shortcuts are bounded, deduplicate pinned recents, and stay unavailable until fresh hydration succeeds", () => {
  const pins = Array.from({ length: 6 }, (_, index) => ({
    ...row(index),
    pinned: true,
  }));
  const model = {
    ...openedBrowser(),
    recentIds: [row(0).id, row(30).id],
    shortcuts: {
      loading: false,
      error: "",
      data: { rows: pins, recents: [{ ...row(0), pinned: true }, row(30)] },
    },
  };
  assert.deepEqual(
    visibleSavedViews(model).map((entry) => entry.id),
    [...pins.slice(0, 5).map((entry) => entry.id), row(30).id],
  );
  assert.deepEqual(
    visibleSavedViews({
      ...model,
      shortcuts: { ...model.shortcuts, loading: true },
    }),
    [],
  );
  assert.deepEqual(
    visibleSavedViews({
      ...model,
      shortcuts: { ...model.shortcuts, error: "Unavailable" },
    }),
    [],
  );
});

test("refreshing an open browser preserves loaded pages and rejects responses from before a mutation", () => {
  const browsing = updateBrowser(openedBrowser(), M.BrowseSavedViews()).model;
  const first = updateBrowser(
    browsing,
    result(browsing.searchVersion, [row(1)]),
  ).model;
  const loaded = updateBrowser(
    first,
    result(first.searchVersion, [row(2)], true),
  ).model;
  const refreshed = refreshBrowser(loaded, row(1).id);
  const stale = updateBrowser(
    refreshed.model,
    result(loaded.searchVersion, [row(3)]),
  ).model;
  assert.deepEqual(
    visibleSavedViews(stale).map((entry) => entry.id),
    [row(1).id, row(2).id],
  );
  const replacement = updateBrowser(
    stale,
    M.CompletedCancelLoadSavedViews({
      version: stale.searchVersion,
      more: false,
      debounce: false,
    }),
  );
  assert.equal(
    replacement.commands?.find((command) => command.name === "LoadSavedViews")
      ?.args?.pages,
    2,
  );
  assert.equal(
    refreshed.commands?.find(
      (command) => command.name === "LoadSavedViewShortcuts",
    )?.args?.removedId,
    row(1).id,
  );
});

test("a deleted recent view is removed while the browser is closed without starting a request", () => {
  const refreshed = refreshBrowser(
    { ...initBrowser(), recentIds: [row(1).id, row(2).id] },
    row(1).id,
  );
  assert.deepEqual(refreshed.model.recentIds, [row(2).id]);
  assert.equal(refreshed.commands?.length ?? 0, 0);
});
