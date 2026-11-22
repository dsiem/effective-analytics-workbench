import { Schema } from "effect";
import { CursorPage, CursorTimestamp } from "./cursor-page.js";
import { boundedText, Id } from "./schema.js";
import { Filters } from "./filters.js";

export const SavedViewVersion = Schema.Int.check(Schema.isGreaterThan(0));
export const SavedViewInput = Schema.Struct({
  id: Id,
  title: boundedText(160),
  body: Schema.String.check(Schema.isMaxLength(10000)),
  filters: Filters,
  version: Schema.NullOr(SavedViewVersion),
});
export const SavedViewPin = Schema.Struct({
  version: SavedViewVersion,
  pinned: Schema.Boolean,
});
export type SavedViewPin = typeof SavedViewPin.Type;
export const SavedView = Schema.Struct({
  ...SavedViewInput.fields,
  version: SavedViewVersion,
  pinned: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type SavedView = typeof SavedView.Type;
export type SavedViewInput = typeof SavedViewInput.Type;

export const SavedViewCursor = Schema.Struct({
  id: Id,
  pinned: Schema.Boolean,
  // Preserve PostgreSQL's microseconds when resuming the database ordering.
  updatedAt: CursorTimestamp,
});
export type SavedViewCursor = typeof SavedViewCursor.Type;
export const SavedViewSearch = Schema.Struct({
  cursor: Schema.optionalKey(Schema.fromJsonString(SavedViewCursor)),
  q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  ids: Schema.optionalKey(
    Schema.fromJsonString(Schema.Array(Id).check(Schema.isMaxLength(5))),
  ),
});
export type SavedViewSearch = typeof SavedViewSearch.Type;

export const SavedViewsPage = CursorPage(SavedView, SavedViewCursor);
export type SavedViewsPage = typeof SavedViewsPage.Type;
