import { Effect, Layer } from "effect";
import { embeddedPostgres } from "./embedded-postgres.js";
import { Lakebase } from "../src/lakebase.js";
import { initializeAppSchema } from "../src/lakebase-schema.js";
import { SavedViews } from "../src/saved-views.js";
import { TripComments } from "../src/trip-comments.js";

// Run production feature services, queries and migrations against embedded Postgres.
export const lakebaseFixture = Effect.gen(function* () {
  const sql = yield* embeddedPostgres;
  yield* initializeAppSchema(sql);
  const features = yield* Effect.all({
    savedViews: SavedViews,
    tripComments: TripComments,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SavedViews.layer, TripComments.layer).pipe(
        Layer.provide(
          Layer.succeed(Lakebase, {
            use: (run) => run(sql),
          }),
        ),
      ),
    ),
  );
  return {
    sql,
    ...features,
  };
});
