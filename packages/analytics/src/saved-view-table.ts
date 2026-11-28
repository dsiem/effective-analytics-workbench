import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

export interface SavedViewTable {
  readonly schema: string;
  readonly name: string;
}

export const initializeSavedViewTable = (
  sql: SqlClient.SqlClient,
  { schema, name }: SavedViewTable,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const target = sql`${sql(schema)}.${sql(name)}`;
      yield* sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
      yield* sql`CREATE TABLE IF NOT EXISTS ${target} (
      id uuid PRIMARY KEY,
      title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
      body text NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
      filters jsonb NOT NULL DEFAULT '{}',
      pinned boolean NOT NULL DEFAULT false,
      last_write text NOT NULL DEFAULT 'create' CHECK (last_write IN ('create', 'edit', 'pin', 'delete')),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
      yield* sql`CREATE INDEX IF NOT EXISTS ${sql(name + "_listing_idx")} ON ${target} (pinned DESC, updated_at DESC, id DESC)`;
    }),
  );
