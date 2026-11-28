import { Context, Effect, Layer } from "effect";
import type { CurrentUser } from "@dsiem/analytics-shared/current-user";
import type {
  TripComment,
  TripCommentInput,
  TripCommentSearch,
  TripCommentCountSearch,
} from "@dsiem/analytics-shared/trip-comments";
import { TripSnapshot } from "@dsiem/analytics-shared/trips";
import { taxiCommentTable } from "./lakebase-schema.js";
import type { SqlClient } from "effect/sql/SqlClient";
import { Lakebase } from "./lakebase.js";
import { makeRecordComments } from "@dsiem/analytics/record-comments";

const makeTripComments = (sql: SqlClient) =>
  makeRecordComments(sql, {
    table: taxiCommentTable,
    snapshot: TripSnapshot,
    recordId: (trip) => trip.trip_id,
    readDeniedMessage: "The trip is in view. The comments are under lock.",
  });

type Stored = Omit<TripComment, "trip"> & { readonly record: TripSnapshot };
const asTripComment = ({ record: trip, ...fields }: Stored): TripComment => ({
  ...fields,
  trip,
});

const makeTripCommentsService = (database: typeof Lakebase.Service) => ({
  counts: ({ tripIds }: TripCommentCountSearch) =>
    database.use((sql) => makeTripComments(sql).counts(tripIds)),
  list: ({ tripId, ...rest }: TripCommentSearch) =>
    database
      .use((sql) => makeTripComments(sql).list({ recordId: tripId, ...rest }))
      .pipe(
        Effect.map(({ rows, nextCursor }) => ({
          rows: rows.map(asTripComment),
          nextCursor,
        })),
      ),
  add: ({ trip, ...draft }: TripCommentInput, author: CurrentUser | null) =>
    database
      .use((sql) =>
        makeTripComments(sql).add({ ...draft, record: trip }, author),
      )
      .pipe(Effect.map(asTripComment)),
});

export class TripComments extends Context.Service<
  TripComments,
  ReturnType<typeof makeTripCommentsService>
>()("app/TripComments") {
  static readonly layer = Layer.effect(
    TripComments,
    Effect.map(Lakebase, makeTripCommentsService),
  );
}
