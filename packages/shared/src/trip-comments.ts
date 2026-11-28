import { Schema } from "effect";
import {
  CommentCounts,
  CommentCursor,
  commentSchemas,
} from "@dsiem/analytics/contracts";
import { TripSnapshot } from "./trips.js";

export {
  CommentCursor as TripCommentCursor,
  CommentCounts as TripCommentCounts,
};
export const {
  Input: TripCommentInput,
  Comment: TripComment,
  Page: TripComments,
} = commentSchemas({ trip: TripSnapshot });
export type TripCommentInput = typeof TripCommentInput.Type;
export type TripComment = typeof TripComment.Type;
export type TripComments = typeof TripComments.Type;

export const TripCommentSearch = Schema.Struct({
  tripId: TripSnapshot.fields.trip_id,
  cursor: Schema.optionalKey(Schema.fromJsonString(CommentCursor)),
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
