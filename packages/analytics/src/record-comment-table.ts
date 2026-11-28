import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

export interface RecordCommentTable {
  readonly schema: string;
  readonly name: string;
  readonly keyColumn: string;
  readonly snapshotColumn: string;
}

export const initializeRecordCommentTable = (
  sql: SqlClient,
  { schema, name, keyColumn, snapshotColumn }: RecordCommentTable,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const target = sql`${sql(schema)}.${sql(name)}`;
      yield* sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
      yield* sql`CREATE TABLE IF NOT EXISTS ${target} (
        id uuid PRIMARY KEY,
        ${sql(keyColumn)} text NOT NULL,
        ${sql(snapshotColumn)} jsonb NOT NULL,
        body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
        author jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(name + "_listing_idx")} ON ${target} (${sql(keyColumn)}, created_at DESC, id DESC)`;
    }),
  );
