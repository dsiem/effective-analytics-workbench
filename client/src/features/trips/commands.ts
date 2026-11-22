import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { Id } from "../../../../shared/schema";
import { TripCommentCursor } from "../../../../shared/trip-comments";
import { Filters } from "../../../../shared/filters";
import { TripCursor, TripSnapshot, TripSort } from "../../../../shared/trips";
import { request } from "../../lib/api-client";
import { result } from "../../lib/command-result";
import { Message as M } from "./messages";
export const LoadTrips = Command.define("LoadTrips", {
  args: {
    generation: Schema.Int,
    filters: Filters,
    cursor: Schema.NullOr(TripCursor),
    sort: TripSort,
  },
  messages: [M.LoadedTrips],
  execute: ({ generation, filters, cursor, sort }) =>
    result(
      request((client) =>
        client.trips({
          query: { ...filters, sort, ...(cursor ? { cursor } : {}) },
        }),
      ),
    ).pipe(Effect.map((value) => M.LoadedTrips({ generation, ...value }))),
});
export const LoadComments = Command.define("LoadComments", {
  args: {
    tripId: TripSnapshot.fields.trip_id,
    generation: Schema.Int,
    cursor: Schema.NullOr(TripCommentCursor),
    more: Schema.Boolean,
  },
  messages: [M.LoadedComments],
  execute: ({ tripId, generation, cursor, more }) =>
    result(
      request((client) =>
        client.tripComments({
          query: { tripId, ...(cursor ? { cursor } : {}) },
        }),
      ),
    ).pipe(
      Effect.map((value) =>
        M.LoadedComments({ tripId, generation, ...value, more }),
      ),
    ),
});
export const LoadCommentCounts = Command.define("LoadCommentCounts", {
  args: {
    tripIds: Schema.Array(TripSnapshot.fields.trip_id),
    version: Schema.Number,
  },
  messages: [M.LoadedCommentCounts],
  execute: ({ tripIds, version }) =>
    result(
      request((client) => client.tripCommentCounts({ query: { tripIds } })),
    ).pipe(Effect.map((value) => M.LoadedCommentCounts({ version, ...value }))),
});
export const PostComment = Command.define("PostComment", {
  args: {
    trip: TripSnapshot,
    body: Schema.String,
    retryId: Schema.NullOr(Id),
  },
  messages: [M.PostedComment],
  execute: ({ trip, body, retryId }) =>
    Effect.gen(function* () {
      const input = { trip, body, id: retryId ?? crypto.randomUUID() };
      const { error } = yield* result(
        request((client) => client.addTripComment({ payload: input })),
      );
      return M.PostedComment({ input, error });
    }),
});
