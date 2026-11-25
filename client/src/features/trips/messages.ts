import { Dialog, Menu } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import {
  TripComment,
  TripCommentCounts,
  TripCommentInput,
  TripComments,
} from "@dsiem/analytics-shared/trip-comments";
import { Trip, TripSummary } from "@dsiem/analytics-shared/trips";
import { Completion } from "../../lib/command-result";
import { Notice } from "../../lib/request-state";
import { Sort, TripViewport } from "./model";

export const messages = {
  CloseTrip: {},
  ResetTrips: {},
  GotInspectorDialogMessage: { message: Dialog.Message },
  TripBatchReceived: {
    generation: Schema.Int,
    rows: Schema.Array(TripSummary),
  },
  TripPreviewFinished: {
    generation: Schema.Int,
    result: Schema.Union([
      Schema.TaggedStruct("Complete", { hasMore: Schema.Boolean }),
      Schema.TaggedStruct("Failed", { error: Notice }),
    ]),
  },
  TripsScrolled: { viewport: TripViewport, generation: Schema.Int },
  SortTrips: { sort: Sort },
  GotSortMenuMessage: { message: Menu.Message },
  InspectTrip: { trip: TripSummary },
  InspectComments: { trip: TripSummary },
  RetryTripDetails: {},
  LoadedTripDetails: {
    tripId: TripSummary.fields.trip_id,
    generation: Schema.Int,
    result: Completion(Trip),
  },
  RetryCommentCounts: {},
  LoadedCommentCounts: {
    version: Schema.Int,
    result: Completion(TripCommentCounts),
  },
  LoadComments: { more: Schema.Boolean },
  LoadedComments: {
    tripId: Schema.String,
    generation: Schema.Int,
    result: Completion(TripComments),
  },
  CommentChanged: { body: Schema.String },
  PostComment: {},
  PostedComment: {
    input: TripCommentInput,
    result: Completion(TripComment),
  },
};

export const Message = defineMessageUnion(messages);
export type Message = typeof Message.Type;
