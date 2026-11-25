import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

// Explicit setup command only. App startup never changes database schemas.
export const initializeAppSchema = (
  sql: SqlClient.SqlClient,
  appPrincipal?: string,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(58302611)`;
      yield* sql`CREATE SCHEMA IF NOT EXISTS app`;
      yield* sql`CREATE TABLE IF NOT EXISTS app.saved_views (
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
      yield* sql`CREATE INDEX IF NOT EXISTS saved_views_listing_idx ON app.saved_views (pinned DESC, updated_at DESC, id DESC)`;
      yield* sql`CREATE TABLE IF NOT EXISTS app.trip_comments (
        id uuid PRIMARY KEY,
        trip_key text NOT NULL,
        trip jsonb NOT NULL,
        body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
        author jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      yield* sql`CREATE INDEX IF NOT EXISTS trip_comments_listing_idx ON app.trip_comments (trip_key, created_at DESC, id DESC)`;
      if (appPrincipal) {
        yield* sql`GRANT USAGE ON SCHEMA app TO ${sql(appPrincipal)}`;
        yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON app.saved_views TO ${sql(appPrincipal)}`;
        yield* sql`GRANT SELECT, INSERT, UPDATE ON app.trip_comments TO ${sql(appPrincipal)}`;
      }
    }),
  );
