import { Schema } from "effect";
import { CurrentUser } from "./current-user.js";
import { CursorPage, CursorTimestamp } from "./cursor-page.js";
import { boundedText, Id } from "./schema.js";
import { TripSnapshot } from "./trips.js";

export const TripCommentInput = Schema.Struct({
  id: Id,
  trip: TripSnapshot,
  body: boundedText(4000).check(
    Schema.makeFilter((body) => body.trim().length > 0),
  ),
});
export type TripCommentInput = typeof TripCommentInput.Type;
export const TripComment = Schema.Struct({
  ...TripCommentInput.fields,
  author: Schema.NullOr(CurrentUser),
  created_at: Schema.String,
});
export type TripComment = typeof TripComment.Type;

export const TripCommentCursor = Schema.Struct({
  id: Id,
  createdAt: CursorTimestamp,
});
export type TripCommentCursor = typeof TripCommentCursor.Type;
export const TripCommentSearch = Schema.Struct({
  tripId: TripSnapshot.fields.trip_id,
  cursor: Schema.optionalKey(Schema.fromJsonString(TripCommentCursor)),
});
export type TripCommentSearch = typeof TripCommentSearch.Type;
export const tripCommentCountLimit = 25;
export const TripCommentCountSearch = Schema.Struct({
  tripIds: Schema.fromJsonString(
    Schema.Array(TripSnapshot.fields.trip_id).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(tripCommentCountLimit),
    ),
  ),
});
export type TripCommentCountSearch = typeof TripCommentCountSearch.Type;
export const TripCommentCounts = Schema.Record(Schema.String, Schema.Natural);

export const TripComments = CursorPage(TripComment, TripCommentCursor);
export type TripComments = typeof TripComments.Type;
