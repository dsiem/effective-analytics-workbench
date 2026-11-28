import { Effect, Schema } from "effect";
import { readFindingPages } from "@dsiem/workbench-ui/findings";
import { Command } from "foldkit";
import * as Dom from "foldkit/dom";
import {
  SavedView,
  SavedViewCursor,
  SavedViewInput,
} from "@dsiem/analytics-shared/saved-views";
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
export const CreateSavedViewDraft = Command.define("CreateSavedViewDraft", {
  args: {},
  messages: [M.CreatedSavedView],
  execute: () =>
    Effect.sync(() => M.CreatedSavedView({ id: crypto.randomUUID() })),
});
export const SaveSavedView = Command.define("SaveSavedView", {
  args: { draft: SavedViewInput },
  messages: [M.SavedViewSaved],
  execute: ({ draft }) =>
    result(
      request((client) =>
        client.savedViews.save({
          payload: { ...draft, title: draft.title.trim() },
        }),
      ),
    ).pipe(Effect.map((result) => M.SavedViewSaved({ result }))),
});
export const LoadSavedViews = Command.define("LoadSavedViews", {
  args: {
    cursor: Schema.NullOr(SavedViewCursor),
    pages: Schema.Number,
    more: Schema.Boolean,
    query: Schema.String,
    version: Schema.Number,
    debounce: Schema.Boolean,
  },
  interrupt: true,
  messages: [M.LoadedSavedViews],
  execute: ({ cursor, pages, more, query, version, debounce }) =>
    result(
      Effect.gen(function* () {
        if (debounce) yield* Effect.sleep("180 millis");
        return yield* readFindingPages({ cursor, pages }, (next) =>
          request((client) =>
            client.savedViews.list({
              query: {
                ...(query ? { q: query } : {}),
                ...(next ? { cursor: next } : {}),
              },
            }),
          ),
        );
      }),
    ).pipe(
      Effect.map((result) =>
        M.LoadedSavedViews({ result, more, pages, version }),
      ),
    ),
});
export const PinSavedView = Command.define("PinSavedView", {
  args: { savedView: SavedView },
  messages: [M.MutatedSavedView],
  execute: ({ savedView }) =>
    result(
      request((client) =>
        client.savedViews.pin({
          params: { id: savedView.id },
          payload: { pinned: !savedView.pinned, version: savedView.version },
        }),
      ).pipe(Effect.as({ removed: false })),
    ).pipe(Effect.map((result) => M.MutatedSavedView({ result }))),
});
export const DeleteSavedView = Command.define("DeleteSavedView", {
  args: { savedView: SavedView },
  messages: [M.MutatedSavedView],
  execute: ({ savedView }) =>
    result(
      request((client) =>
        client.savedViews.remove({
          params: { id: savedView.id },
          query: { version: savedView.version },
        }),
      ).pipe(Effect.as({ removed: true })),
    ).pipe(Effect.map((result) => M.MutatedSavedView({ result }))),
});
