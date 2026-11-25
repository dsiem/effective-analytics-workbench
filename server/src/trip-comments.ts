import { Context, Effect, Layer, Schema } from "effect";
import * as SqlSchema from "effect/sql/SqlSchema";
import { pageWindow } from "@dsiem/analytics-shared/cursor-page";
import type { CurrentUser } from "@dsiem/analytics-shared/current-user";
import {
  TripComment,
  type TripCommentCountSearch,
  TripCommentCounts,
  TripCommentCursor,
  type TripCommentInput,
  type TripCommentSearch,
  type TripComments as TripCommentsPage,
} from "@dsiem/analytics-shared/trip-comments";
import { InvalidRequest } from "./errors.js";
import { Lakebase, type LakebaseSql, lakebaseFailure } from "./lakebase.js";

const page = pageWindow(25);

const makeTripComments = (sql: LakebaseSql) => {
  const counts = ({ tripIds }: TripCommentCountSearch) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        trip_key: Schema.String,
        count: TripCommentCounts.value,
      }),
      execute: () => sql`SELECT trip_key, count(*)::int AS count
        FROM app.trip_comments
        WHERE ${sql.in("trip_key", tripIds)} GROUP BY trip_key`,
    })(undefined).pipe(
      Effect.mapError(
        lakebaseFailure("The trip is in view. The comments are under lock."),
      ),
      Effect.map((rows) => ({
        ...Object.fromEntries(tripIds.map((id) => [id, 0])),
        ...Object.fromEntries(rows.map((row) => [row.trip_key, row.count])),
      })),
      Effect.withSpan("tripComments.counts"),
    );
  const columns = sql`id::text AS id, trip, body, author,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;
  const list = (search: TripCommentSearch) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        ...TripComment.fields,
        cursor_created_at: TripCommentCursor.fields.createdAt,
      }),
      execute: () => sql`SELECT ${columns},
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
        FROM app.trip_comments AS comments
        WHERE trip_key=${search.tripId}
        ${
          search.cursor
            ? sql`AND (created_at, id) <
          (${search.cursor.createdAt}::timestamptz, ${search.cursor.id}::uuid)`
            : sql``
        }
        ORDER BY comments.created_at DESC, comments.id DESC LIMIT ${page.fetchLimit}`,
    })(undefined).pipe(
      Effect.mapError(
        lakebaseFailure("The trip is in view. The comments are under lock."),
      ),
      Effect.map((results): TripCommentsPage =>
        page.fromRows(results, {
          row: ({ cursor_created_at: _, ...comment }) => comment,
          cursor: ({ id, cursor_created_at }) => ({
            id,
            createdAt: cursor_created_at,
          }),
        }),
      ),
      Effect.withSpan("tripComments.list"),
    );
  const add = (input: TripCommentInput, author: CurrentUser | null) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: TripComment,
      // A repeated submission of the same draft is safe after a lost response.
      // An existing ID can never replace another comment's content or author.
      execute:
        () => sql`INSERT INTO app.trip_comments AS existing (id,trip_key,trip,body,author)
        VALUES (${input.id}::uuid,${input.trip.trip_id},${sql.json(input.trip)},${input.body},${author === null ? sql`'null'::jsonb` : sql.json(author)})
        ON CONFLICT (id) DO UPDATE SET id=existing.id
        WHERE existing.trip_key=EXCLUDED.trip_key AND existing.body=EXCLUDED.body
          AND existing.author=EXCLUDED.author
        RETURNING ${columns}`,
    })(undefined).pipe(
      Effect.mapError(
        lakebaseFailure("You need permission to post this comment."),
      ),
      Effect.flatMap((rows) =>
        rows[0]
          ? Effect.succeed(rows[0])
          : Effect.fail(
              new InvalidRequest({
                message:
                  "This comment was already submitted with different content. Edit the draft to post a new comment.",
              }),
            ),
      ),
      Effect.withSpan("tripComments.add"),
    );
  return { list, add, counts };
};

const makeTripCommentsService = (database: typeof Lakebase.Service) => ({
  counts: (search: TripCommentCountSearch) =>
    database.use((sql) => makeTripComments(sql).counts(search)),
  list: (search: TripCommentSearch) =>
    database.use((sql) => makeTripComments(sql).list(search)),
  add: (input: TripCommentInput, author: CurrentUser | null) =>
    database.use((sql) => makeTripComments(sql).add(input, author)),
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
