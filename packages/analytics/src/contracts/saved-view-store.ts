import { Schema } from "effect";
import { CursorPage, CursorTimestamp } from "./cursor-page.js";
import { boundedText, Id, Version } from "./fields.js";

export const SavedViewPin = Schema.Struct({
  version: Version,
  pinned: Schema.Boolean,
});
export type SavedViewPin = typeof SavedViewPin.Type;
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

export const savedViewSchemas = <F extends Schema.Top>(filters: F) => {
  const SavedViewInput = Schema.Struct({
    id: Id,
    title: boundedText(160).check(Schema.isPattern(/\S/)),
    body: Schema.String.check(Schema.isMaxLength(10000)),
    filters,
    version: Schema.NullOr(Version),
  });
  const SavedView = Schema.Struct({
    ...SavedViewInput.fields,
    version: Version,
    pinned: Schema.Boolean,
    created_at: Schema.String,
    updated_at: Schema.String,
  });
  const SavedViewsPage = CursorPage(SavedView, SavedViewCursor);
  return { SavedViewInput, SavedView, SavedViewsPage };
};
