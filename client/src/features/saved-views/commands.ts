import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import * as Dom from "foldkit/dom";
import {
  SavedView,
  SavedViewCursor,
  SavedViewInput,
} from "../../../../shared/saved-views";
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
    messages: [M.Idle],
    execute: ({ ids }) =>
      Effect.sync(() => {
        writeRecentIds(ids);
        return M.Idle();
      }),
  },
);
export const RememberRecentSavedView = Command.define(
  "RememberRecentSavedView",
  {
    args: { id: SavedView.fields.id, fallback: RecentIds },
    messages: [M.Idle],
    execute: ({ id, fallback }) =>
      Effect.sync(() => {
        writeRecentIds(rememberRecent(readRecentIds(fallback), id));
        return M.Idle();
      }),
  },
);
export const FocusSavedViewSearch = Command.define("FocusSavedViewSearch", {
  messages: [M.Idle],
  execute: Dom.focus(`#${searchId}`).pipe(Effect.ignore, Effect.as(M.Idle())),
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
          page: request((client) => client.savedViews({ query: {} })),
          recents: ids.length
            ? request((client) => client.savedViews({ query: { ids } })).pipe(
                Effect.map((page) => page.rows),
              )
            : Effect.succeed([]),
        }),
      );
      const data = loaded.data
        ? { rows: loaded.data.page.rows, recents: loaded.data.recents }
        : null;
      return M.LoadedSavedViewShortcuts({
        version,
        data,
        error: loaded.error,
        recentIds: data
          ? ids.filter((id) => data.recents.some((row) => row.id === id))
          : ids,
      });
    }),
});
export const NewSavedView = Command.define("CreateSavedViewDraft", {
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
        client.saveSavedView({
          payload: { ...draft, title: draft.title.trim() },
        }),
      ),
    ).pipe(
      Effect.map(({ data, error }) =>
        M.SavedViewSaved({ savedView: data, error }),
      ),
    ),
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
        let next = cursor;
        const rows: SavedView[] = [];
        for (let page = 0; page < pages; page++) {
          const response = yield* request((client) =>
            client.savedViews({
              query: {
                ...(query ? { q: query } : {}),
                ...(next ? { cursor: next } : {}),
              },
            }),
          );
          rows.push(...response.rows);
          next = response.nextCursor;
          if (!next) break;
        }
        return { rows, nextCursor: next };
      }),
    ).pipe(
      Effect.map((value) =>
        M.LoadedSavedViews({ ...value, more, pages, version }),
      ),
    ),
});
export const PinSavedView = Command.define("PinSavedView", {
  args: { savedView: SavedView },
  messages: [M.MutatedSavedView],
  execute: ({ savedView }) =>
    result(
      request((client) =>
        client.pinSavedView({
          params: { id: savedView.id },
          payload: { pinned: !savedView.pinned, version: savedView.version },
        }),
      ),
    ).pipe(
      Effect.map(({ error }) => M.MutatedSavedView({ error, removed: false })),
    ),
});
export const DeleteSavedView = Command.define("DeleteSavedView", {
  args: { savedView: SavedView },
  messages: [M.MutatedSavedView],
  execute: ({ savedView }) =>
    result(
      request((client) =>
        client.removeSavedView({
          params: { id: savedView.id },
          query: { version: savedView.version },
        }),
      ),
    ).pipe(
      Effect.map(({ error }) => M.MutatedSavedView({ error, removed: true })),
    ),
});
