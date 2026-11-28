import { Effect, Schema } from "effect";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { SqlClient } from "effect/sql/SqlClient";
import { pageWindow } from "./contracts/cursor-page.js";
import type { UserIdentity } from "./contracts/user-identity.js";
import {
  CommentCursor,
  CommentCounts,
  commentSchemas,
} from "./contracts/record-comments.js";
import { InvalidRequest } from "./errors.js";
import { postgresFailure } from "./errors.js";
import type { RecordCommentTable } from "./record-comment-table.js";

const page = pageWindow(25);

export const makeRecordComments = <Snapshot, Encoded extends Schema.Json>(
  sql: SqlClient,
  {
    table,
    snapshot,
    recordId,
    readDeniedMessage = "You need permission to read these comments.",
  }: {
    readonly table: RecordCommentTable;
    readonly snapshot: Schema.Codec<Snapshot, Encoded>;
    readonly recordId: (snapshot: Snapshot) => string;
    readonly readDeniedMessage?: string;
  },
) => {
  const { Input, Comment } = commentSchemas({ record: snapshot });
  const target = sql`${sql(table.schema)}.${sql(table.name)}`;
  const key = sql(table.keyColumn);
  const snapshotColumn = sql(table.snapshotColumn);
  const counts = (recordIds: readonly string[]) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        record_key: Schema.String,
        count: CommentCounts.value,
      }),
      execute: () => sql`SELECT ${key} AS record_key, count(*)::int AS count
        FROM ${target}
        WHERE ${sql.in(table.keyColumn, recordIds)} GROUP BY ${key}`,
    })(undefined).pipe(
      Effect.mapError(postgresFailure(readDeniedMessage)),
      Effect.map((rows) => ({
        ...Object.fromEntries(recordIds.map((id) => [id, 0])),
        ...Object.fromEntries(rows.map((row) => [row.record_key, row.count])),
      })),
      Effect.withSpan("recordComments.counts"),
    );
  const columns = sql`id::text AS id, ${snapshotColumn} AS record, body, author,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;
  const list = (search: {
    readonly recordId: string;
    readonly cursor?: CommentCursor;
  }) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        ...Comment.fields,
        cursor_created_at: CommentCursor.fields.createdAt,
      }),
      execute: () => sql`SELECT ${columns},
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
        FROM ${target} AS comments
        WHERE ${key}=${search.recordId}
        ${
          search.cursor
            ? sql`AND (created_at, id) <
          (${search.cursor.createdAt}::timestamptz, ${search.cursor.id}::uuid)`
            : sql``
        }
        ORDER BY comments.created_at DESC, comments.id DESC LIMIT ${page.fetchLimit}`,
    })(undefined).pipe(
      Effect.mapError(postgresFailure(readDeniedMessage)),
      Effect.map((results) =>
        page.fromRows(results, {
          row: ({ cursor_created_at: _, ...comment }) => comment,
          cursor: ({ id, cursor_created_at }) => ({
            id,
            createdAt: cursor_created_at,
          }),
        }),
      ),
      Effect.withSpan("recordComments.list"),
    );
  const add = (input: typeof Input.Type, author: UserIdentity | null) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(snapshot)(input.record).pipe(
        Effect.mapError(
          (cause) =>
            new InvalidRequest({
              message: "The record snapshot is invalid.",
              cause,
            }),
        ),
      );
      return yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Comment,
        execute:
          () => sql`INSERT INTO ${target} AS existing (id,${key},${snapshotColumn},body,author)
          VALUES (${input.id}::uuid, ${recordId(input.record)}, ${JSON.stringify(encoded)}::jsonb,
            ${input.body}, ${JSON.stringify(author)}::jsonb)
          ON CONFLICT (id) DO UPDATE SET id=existing.id
          WHERE existing.${key}=EXCLUDED.${key} AND existing.body=EXCLUDED.body
            AND existing.author=EXCLUDED.author
          RETURNING ${columns}`,
      })(undefined).pipe(
        Effect.mapError(
          postgresFailure("You need permission to post this comment."),
        ),
        Effect.flatMap(([row]) =>
          row
            ? Effect.succeed(row)
            : Effect.fail(
                new InvalidRequest({
                  message:
                    "This comment was already submitted with different content. Edit the draft to post a new comment.",
                }),
              ),
        ),
      );
    }).pipe(Effect.withSpan("recordComments.add"));
  return { list, add, counts };
};

export {
  initializeRecordCommentTable,
  type RecordCommentTable,
} from "./record-comment-table.js";
