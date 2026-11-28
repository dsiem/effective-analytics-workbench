import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import {
  initializeLocalRunTable,
  makeLocalRuns,
} from "@dsiem/analytics/local-runs";
import { embeddedPostgres } from "./embedded-postgres.js";

test("a local calculation that fails mid-transaction rolls back before a retry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* embeddedPostgres;
      const table = { schema: "lab", name: "checks" };
      yield* initializeLocalRunTable(sql, table);
      yield* sql`CREATE TABLE measurements (units integer)`;
      const request = { input: { units: 5 }, requestId: randomUUID() };
      let fail = true;
      const runs = makeLocalRuns(sql, {
        table,
        input: Schema.Struct({ units: Schema.Natural }),
        report: Schema.Struct({ doubled: Schema.Natural }),
        calculate: ({ units }) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO measurements VALUES (${units})`;
            if (fail) return yield* Effect.fail("incomplete calculation");
            return { doubled: units * 2 };
          }),
      });
      assert.equal(
        yield* Effect.flip(runs.submit(request)),
        "incomplete calculation",
      );
      assert.deepEqual(yield* runs.list, []);
      assert.deepEqual(yield* sql`SELECT units FROM measurements`, []);
      fail = false;
      const run = yield* runs.submit(request);
      assert.deepEqual(yield* runs.result(run.id), { doubled: 10 });
      assert.deepEqual(yield* runs.submit(request), run);
      assert.deepEqual(yield* sql`SELECT units FROM measurements`, [
        { units: 5 },
      ]);
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});
