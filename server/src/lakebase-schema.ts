import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { initializeSavedViewTable } from "@dsiem/analytics/saved-views";
import { initializeRecordCommentTable } from "@dsiem/analytics/record-comments";

export const taxiSavedViewTable = { schema: "app", name: "saved_views" };
export const taxiCommentTable = {
  schema: "app",
  name: "trip_comments",
  keyColumn: "trip_key",
  snapshotColumn: "trip",
};

// Explicit setup command only. App startup never changes database schemas.
export const initializeAppSchema = (
  sql: SqlClient.SqlClient,
  appPrincipal?: string,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(58302611)`;
      yield* initializeSavedViewTable(sql, taxiSavedViewTable);
      yield* initializeRecordCommentTable(sql, taxiCommentTable);
      if (appPrincipal) {
        yield* sql`GRANT USAGE ON SCHEMA app TO ${sql(appPrincipal)}`;
        yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON app.saved_views TO ${sql(appPrincipal)}`;
        yield* sql`GRANT SELECT, INSERT, UPDATE ON app.trip_comments TO ${sql(appPrincipal)}`;
      }
    }),
  );
