import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { makeRecordComments } from "@dsiem/analytics/record-comments";
import { initializeRecordCommentTable } from "@dsiem/analytics/record-comments";
import { lakebaseFixture } from "./lakebase-fixture.js";

test("an order annotation preserves its original snapshot on resubmission and keeps taxi rows readable", async () => {
  const table = {
    schema: "order-ops",
    name: "order notes",
    keyColumn: "order ref",
    snapshotColumn: "order",
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const { sql, tripComments } = yield* lakebaseFixture;
      const id = randomUUID();
      const trip = {
        trip_id: randomUUID(),
        pickup_at: "2016-01-20 09:42:00",
        dropoff_at: "2016-01-20 09:56:00",
        pickup_zip: "10001",
        dropoff_zip: "10019",
        distance: 3.2,
        fare: 18.5,
        duration: 14,
      };
      yield* sql`INSERT INTO app.trip_comments (id, trip_key, trip, body, author)
      VALUES (${id}::uuid, ${trip.trip_id}, ${JSON.stringify(trip)}::jsonb, 'Earlier note', 'null'::jsonb)`;
      yield* initializeRecordCommentTable(sql, table);
      const notes = makeRecordComments(sql, {
        table,
        snapshot: Schema.Struct({
          reference: Schema.String,
          remaining: Schema.Natural,
        }),
        recordId: (order) => order.reference,
      });
      const draft = {
        id,
        record: {
          reference: "B-44",
          remaining: 5,
        } as const,
        body: "Expedite the outstanding units",
      };
      const author = { name: "Sam", email: null };
      const note = yield* notes.add(draft, author);
      assert.deepEqual(note.record, draft.record);
      assert.deepEqual(
        yield* notes.add(
          { ...draft, record: { ...draft.record, remaining: 2 } },
          author,
        ),
        note,
      );
      assert.equal(
        (yield* Effect.flip(notes.add(draft, null)))._tag,
        "InvalidRequest",
      );
      assert.deepEqual(yield* notes.counts(["B-44", "B-45"]), {
        "B-44": 1,
        "B-45": 0,
      });
      assert.deepEqual(yield* notes.list({ recordId: "B-44" }), {
        rows: [note],
        nextCursor: null,
      });
      const [legacy] = (yield* tripComments.list({ tripId: trip.trip_id }))
        .rows;
      assert.deepEqual(legacy?.trip, trip);
      assert.equal(legacy?.body, "Earlier note");
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});
