import { Notice } from "../../lib/request-state";
import { Dialog } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import {
  TripCommentCounts,
  TripCommentInput,
  TripComments,
} from "../../../../shared/trip-comments";
import { TripSnapshot, Trips } from "../../../../shared/trips";
import { Sort } from "./model";

export const messages = {
  CloseTrip: {},
  ResetTrips: {},
  InspectorDialog: { message: Dialog.Message },
  LoadedTrips: {
    generation: Schema.Int,
    data: Schema.NullOr(Trips),
    error: Notice,
  },
  NextPage: {},
  PreviousPage: {},
  SortTrips: { sort: Sort },
  InspectTrip: { trip: TripSnapshot },
  InspectComments: { trip: TripSnapshot },
  LoadedCommentCounts: {
    version: Schema.Number,
    data: Schema.NullOr(TripCommentCounts),
    error: Notice,
  },
  LoadComments: { more: Schema.Boolean },
  LoadedComments: {
    tripId: Schema.String,
    generation: Schema.Int,
    data: Schema.NullOr(TripComments),
    error: Notice,
    more: Schema.Boolean,
  },
  CommentChanged: { body: Schema.String },
  PostComment: {},
  PostedComment: { input: TripCommentInput, error: Notice },
};

export const Message = defineMessageUnion({ Idle: {}, ...messages });
export type Message = typeof Message.Type;
