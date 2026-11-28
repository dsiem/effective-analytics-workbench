import { PgClient } from "@effect/sql-pg";
import { PGlite } from "@electric-sql/pglite";
import { Effect, Semaphore, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, UnknownError } from "effect/sql/SqlError";

export const embeddedPostgres = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.promise(() => PGlite.create()),
    (db) => Effect.promise(() => db.close()),
  );
  const queryError = (cause: unknown) =>
    new SqlError({
      reason: new UnknownError({ cause, operation: "execute" }),
    });
  const execute: Connection["execute"] = (text, params, transform) =>
    Effect.tryPromise({
      try: async () => {
        const { rows } = await database.query<object>(text, [...params]);
        return transform ? transform(rows) : rows;
      },
      catch: queryError,
    });
  const executeValues: Connection["executeValues"] = (text, params) =>
    Effect.tryPromise({
      try: async () =>
        (
          await database.query<unknown[]>(text, [...params], {
            rowMode: "array",
          })
        ).rows,
      catch: queryError,
    });
  const connection: Connection = {
    execute,
    executeUnprepared: execute,
    executeRaw: (text, params) =>
      Effect.tryPromise({
        try: () => database.query(text, [...params]),
        catch: queryError,
      }),
    executeStream: (text, params, transform) =>
      Stream.fromEffect(execute(text, params, transform)).pipe(
        Stream.flatMap(Stream.fromIterable),
      ),
    executeValues,
    executeValuesUnprepared: executeValues,
  };
  const lease = Semaphore.makeUnsafe(1);
  return yield* SqlClient.make({
    driver: "pg",
    spanAttributes: [],
    compiler: PgClient.makeCompiler(),
    acquirer: lease.takeScoped(1).pipe(Effect.as(connection)),
  });
});
