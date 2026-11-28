import {
  recordInspector,
  recordList,
} from "@dsiem/workbench-ui/record-explorer";
import { Effect, Option, Schema, Stream } from "effect";
import { Filters } from "@dsiem/analytics-shared/filters";
import {
  TripComment,
  TripCommentCursor,
} from "@dsiem/analytics-shared/trip-comments";
import {
  Trip,
  TripSnapshot,
  TripSort,
  TripSummary,
} from "@dsiem/analytics-shared/trips";
import { request } from "../../lib/api-client";
import { failure } from "../../lib/command-result";
import { Notice } from "../../lib/request-state";

const TripQuery = Schema.Struct({ filters: Filters, sort: TripSort });

export const records = recordList({
  row: TripSummary,
  query: TripQuery,
  error: Notice,
  pages: ({ filters, sort }) =>
    Stream.suspend(() => {
      const visited = new Set<string>();
      return Stream.paginate(
        null,
        Effect.fnUntraced(function* (cursor: string | null) {
          const page = yield* request((client) =>
            cursor === null
              ? client.analytics.trips({ query: { ...filters, sort } })
              : client.analytics.tripPage({ params: { cursor } }),
          ).pipe(Effect.scoped, Effect.mapError(failure));
          if (page.nextCursor !== null) {
            if (visited.has(page.nextCursor))
              return yield* Effect.fail(
                "The server repeated a trip page. Try again.",
              );
            visited.add(page.nextCursor);
          }
          return [
            [{ rows: page.rows, hasMore: page.hasMoreMatches }],
            Option.fromNullishOr(page.nextCursor),
          ] as const;
        }),
      );
    }).pipe(
      Stream.interruptWhen(
        Effect.sleep("2 minutes").pipe(
          Effect.andThen(Effect.fail("Trip records timed out. Try again.")),
        ),
      ),
    ),
});

export const inspection = recordInspector({
  reads: "subscriptions",
  row: TripSnapshot,
  detail: Trip,
  error: Notice,
  key: (row) => row.trip_id,
  inspect: ({ trip_id: tripId }) =>
    request((client) =>
      client.analytics.tripDetails({ query: { tripId } }),
    ).pipe(
      Effect.scoped,
      Effect.mapError(failure),
      Effect.flatMap((trip) =>
        trip.trip_id === tripId
          ? Effect.succeed(trip)
          : Effect.fail("Trip details did not match the selected record."),
      ),
    ),
  comments: {
    note: TripComment,
    cursor: TripCommentCursor,
    snapshot: (_row, detail) => detail,
    list: ({ trip_id: tripId }, cursor) =>
      request((client) =>
        client.tripComments.list({
          query: cursor ? { tripId, cursor } : { tripId },
        }),
      ).pipe(Effect.scoped, Effect.mapError(failure)),
    post: (trip, id, body) =>
      request((client) =>
        client.tripComments.add({ payload: { trip, id, body } }),
      ).pipe(Effect.scoped, Effect.mapError(failure)),
  },
});

export const subscriptions = {
  ...records.subscriptions,
  ...inspection.subscriptions,
};
