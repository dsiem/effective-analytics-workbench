import { Dialog } from "@foldkit/ui";
import { Schema } from "effect";
import {
  TripCommentCounts,
  TripCommentInput,
  TripComments,
} from "../../../../shared/trip-comments";
import {
  TripCursor,
  TripSnapshot,
  TripSort,
  Trips,
} from "../../../../shared/trips";
import { empty, Notice, request } from "../../lib/request-state";
export const Sort = TripSort;
const CommentDraft = Schema.Union([
  Schema.Struct({
    state: Schema.Literals(["editing", "posting"]),
    body: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("retry"),
    ...TripCommentInput.fields,
  }),
]);
export const Model = Schema.Struct({
  inspectorDialog: Dialog.Model,
  trips: request(Trips),
  loadGeneration: Schema.Int,
  pageCursors: Schema.Array(TripCursor),
  displayedPage: Schema.Int,
  selectedTrip: Schema.NullOr(TripSnapshot),
  comments: request(TripComments),
  commentLoadGeneration: Schema.Int,
  commentCounts: request(TripCommentCounts),
  commentCountsVersion: Schema.Number,
  commentDrafts: Schema.Record(Schema.String, CommentDraft),
  postingTripId: Schema.NullOr(TripSnapshot.fields.trip_id),
  postError: Notice,
  posted: Schema.String,
});

export type Model = typeof Model.Type;
export const tripPageNumber = (model: Model) => model.pageCursors.length + 1;

export const init = (): Model => ({
  inspectorDialog: Dialog.init({
    id: "trip-details",
    focusSelector: "#trip-details-dialog-title",
  }),
  trips: empty,
  loadGeneration: 0,
  pageCursors: [],
  displayedPage: 1,
  selectedTrip: null,
  comments: empty,
  commentLoadGeneration: 0,
  commentCounts: empty,
  commentCountsVersion: 0,
  commentDrafts: {},
  postingTripId: null,
  postError: "",
  posted: "",
});
