import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import * as Dom from "foldkit/dom";
import { SavedView } from "@dsiem/analytics-shared/saved-views";
import { request } from "../../lib/api-client";
import { result } from "../../lib/command-result";
import { Message as M } from "./messages";
import { RecentIds } from "./browser-model";
import { rememberRecent, searchId } from "./picker";

export const recentStorageKey = "taxi.recent-saved-views";
function readRecentIds(fallback: readonly string[]) {
  try {
    return [
      ...new Set(
        Schema.decodeUnknownSync(Schema.fromJsonString(RecentIds))(
          localStorage.getItem(recentStorageKey) ?? JSON.stringify(fallback),
        ),
      ),
    ];
  } catch {
    return fallback;
  }
}
function writeRecentIds(ids: readonly string[]) {
  try {
    localStorage.setItem(recentStorageKey, JSON.stringify(ids));
  } catch {
    return;
  }
}
export const PersistRecentSavedViews = Command.define(
  "PersistRecentSavedViews",
  {
    args: { ids: RecentIds },
    messages: [M.CompletedPersistRecentSavedViews],
    execute: ({ ids }) =>
      Effect.sync(() => {
        writeRecentIds(ids);
        return M.CompletedPersistRecentSavedViews();
      }),
  },
);
export const RememberRecentSavedView = Command.define(
  "RememberRecentSavedView",
  {
    args: { id: SavedView.fields.id, fallback: RecentIds },
    messages: [M.CompletedRememberRecentSavedView],
    execute: ({ id, fallback }) =>
      Effect.sync(() => {
        writeRecentIds(rememberRecent(readRecentIds(fallback), id));
        return M.CompletedRememberRecentSavedView();
      }),
  },
);
export const FocusSavedViewSearch = Command.define("FocusSavedViewSearch", {
  messages: [M.CompletedFocusSavedViewSearch],
  execute: Dom.focus(`#${searchId}`).pipe(
    Effect.ignore,
    Effect.as(M.CompletedFocusSavedViewSearch()),
  ),
});
export const LoadSavedViewShortcuts = Command.define("LoadSavedViewShortcuts", {
  args: {
    version: Schema.Number,
    fallback: RecentIds,
    removedId: Schema.NullOr(SavedView.fields.id),
  },
  messages: [M.LoadedSavedViewShortcuts],
  execute: ({ version, fallback, removedId }) =>
    Effect.gen(function* () {
      const ids = yield* Effect.sync(() => {
        const ids = readRecentIds(fallback).filter((id) => id !== removedId);
        if (removedId) writeRecentIds(ids);
        return ids;
      });
      const loaded = yield* result(
        Effect.all({
          page: request((client) => client.savedViews.list({ query: {} })),
          recents: ids.length
            ? request((client) =>
                client.savedViews.list({ query: { ids } }),
              ).pipe(Effect.map((page) => page.rows))
            : Effect.succeed([]),
        }).pipe(
          Effect.map(({ page, recents }) => ({ rows: page.rows, recents })),
        ),
      );
      return M.LoadedSavedViewShortcuts({
        version,
        result: loaded,
        recentIds:
          loaded._tag === "Success"
            ? ids.filter((id) =>
                loaded.data.recents.some((row) => row.id === id),
              )
            : ids,
      });
    }),
});
