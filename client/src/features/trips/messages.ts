import { Dialog, Menu } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { TripCommentCounts } from "@dsiem/analytics-shared/trip-comments";
import { TripSummary } from "@dsiem/analytics-shared/trips";
import { Completion } from "../../lib/command-result";
import { inspection, records } from "./records";
import { Sort, TripViewport } from "./model";

export const messages = {
  ResetTrips: {},
  GotInspectorDialogMessage: { message: Dialog.Message },
  ...records.messageFields,
  ...inspection.messageFields,
  TripsScrolled: { viewport: TripViewport, generation: Schema.Int },
  SortTrips: { sort: Sort },
  GotSortMenuMessage: { message: Menu.Message },
  InspectTrip: { trip: TripSummary },
  InspectComments: { trip: TripSummary },
  RetryCommentCounts: {},
  LoadedCommentCounts: {
    version: Schema.Int,
    result: Completion(TripCommentCounts),
  },
};

export const Message = defineMessageUnion(messages);
export type Message = typeof Message.Type;
