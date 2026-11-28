import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { makeSavedViewStore } from "@dsiem/analytics/saved-views";
import { initializeSavedViewTable } from "@dsiem/analytics/saved-views";
import { lakebaseFixture } from "./lakebase-fixture.js";

test("custom saved views round-trip required filters, search their stored keys, and keep deletion retries independent of taxi views", async () => {
  const table = { schema: "order-ops", name: "saved queues" };
  const filters = Schema.Struct({
    depot: Schema.String,
    minimum: Schema.NumberFromString.check(Schema.isInt()),
    category: Schema.String,
  }).pipe(Schema.encodeKeys({ minimum: "min_units" }));

  await Effect.runPromise(
    Effect.gen(function* () {
      const { sql, savedViews: taxi } = yield* lakebaseFixture;
      yield* initializeSavedViewTable(sql, table);
      const views = makeSavedViewStore(sql, {
        table,
        filters,
        searchFields: ["depot", "min_units"],
      });
      const draft = {
        id: randomUUID(),
        title: "Late shipments",
        body: "",
        version: null,
        filters: {
          depot: "South",
          minimum: 42,
          category: "glassware",
        } as const,
      };
      const tripView = yield* taxi.save({
        ...draft,
        filters: { zip: "10001" },
      });
      const saved = yield* views.save(draft);
      assert.deepEqual(saved.filters, draft.filters);
      assert.deepEqual(yield* views.save(draft), saved);
      yield* initializeSavedViewTable(sql, table);
      assert.deepEqual((yield* views.list({ q: "SOUTH 42" })).rows, [saved]);
      assert.deepEqual((yield* views.list({ q: "glassware" })).rows, []);
      assert.deepEqual(
        yield* sql`SELECT filters FROM "order-ops"."saved queues"`,
        [
          {
            filters: { depot: "South", min_units: "42", category: "glassware" },
          },
        ],
      );
      const pinned = yield* views.pin(saved.id, {
        pinned: true,
        version: saved.version,
      });
      assert.equal(
        (yield* Effect.flip(views.remove(saved.id, saved.version)))._tag,
        "SavedViewConflict",
      );
      yield* views.remove(saved.id, pinned.version);
      yield* views.remove(saved.id, pinned.version);
      assert.equal(
        (yield* Effect.flip(views.save(draft)))._tag,
        "SavedViewNotFound",
      );
      assert.deepEqual((yield* views.list({})).rows, []);
      assert.deepEqual(
        yield* sql`SELECT filters FROM "order-ops"."saved queues"`,
        [{ filters: {} }],
      );
      assert.deepEqual((yield* taxi.list({})).rows, [tripView]);
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});
