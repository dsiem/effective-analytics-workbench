import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import {
  TripCommentInput,
  type TripCommentSearch,
} from "../../shared/trip-comments.js";
import type { TripSnapshot } from "../../shared/trips.js";
import { initializeAppSchema } from "../src/lakebase-schema.js";
import { lakebaseFixture } from "./lakebase-fixture.js";

const trip: TripSnapshot = {
  trip_id: "7b2c6ab2-6f7d-4f8a-a05f-d07e4eb84a19",
  pickup_at: "2016-01-20 09:42:00",
  dropoff_at: "2016-01-20 09:56:00",
  pickup_zip: "10001",
  dropoff_zip: "10019",
  distance: 3.2,
  fare: 18.5,
  duration: 14,
};
const author = { name: "Analyst", email: "analyst@example.test" };

test("comment boundaries reject empty, oversized and invalid record payloads", () => {
  const input = { id: randomUUID(), trip, body: "Check the fare" };
  assert.deepEqual(Schema.decodeUnknownSync(TripCommentInput)(input), input);
  for (const body of ["", " \n\t ", "x".repeat(4001)])
    assert.throws(() =>
      Schema.decodeUnknownSync(TripCommentInput)({ ...input, body }),
    );
  assert.throws(() =>
    Schema.decodeUnknownSync(TripCommentInput)({
      ...input,
      trip: { ...trip, fare: "18.50" },
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(TripCommentInput)({
      ...input,
      trip: { ...trip, pickup_at: "x".repeat(81) },
    }),
  );
});

test("comments persist per trip ID, preserve snapshots and authors, and safely replay a lost response", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { tripComments: comments, sql } = yield* lakebaseFixture;
      const input = {
        id: randomUUID(),
        trip,
        body: "Check this fare against similar trips.",
      };
      assert.deepEqual(yield* comments.list({ tripId: trip.trip_id }), {
        rows: [],
        nextCursor: null,
      });
      const otherTripId = randomUUID();
      assert.deepEqual(
        yield* comments.counts({ tripIds: [trip.trip_id, otherTripId] }),
        {
          [trip.trip_id]: 0,
          [otherTripId]: 0,
        },
      );
      const saved = yield* comments.add(input, author);
      yield* initializeAppSchema(sql);
      assert.deepEqual(yield* comments.add(input, author), saved);
      assert.deepEqual((yield* comments.list({ tripId: trip.trip_id })).rows, [
        saved,
      ]);
      assert.equal(saved.body, input.body);
      assert.deepEqual(saved.author, author);
      assert.deepEqual(saved.trip, trip);
      for (const [changed, viewer] of [
        [{ ...input, body: "Different" }, author],
        [{ ...input, trip: { ...trip, trip_id: randomUUID() } }, author],
        [input, { name: "Other", email: null }],
      ] as const) {
        const result = yield* Effect.result(comments.add(changed, viewer));
        assert.ok(
          result._tag === "Failure" && result.failure._tag === "InvalidRequest",
        );
      }
      assert.deepEqual(
        yield* comments.add({ ...input, trip: { ...trip, fare: 25 } }, author),
        saved,
      );
      assert.deepEqual(yield* comments.list({ tripId: randomUUID() }), {
        rows: [],
        nextCursor: null,
      });
      const anonymous = yield* comments.add(
        { ...input, id: randomUUID() },
        null,
      );
      assert.equal(anonymous.author, null);
      assert.deepEqual(yield* comments.add(anonymous, null), anonymous);
      assert.equal(
        (yield* comments.list({ tripId: trip.trip_id })).rows.length,
        2,
      );
      assert.deepEqual(
        yield* comments.counts({ tripIds: [trip.trip_id, otherTripId] }),
        {
          [trip.trip_id]: 2,
          [otherTripId]: 0,
        },
      );
      assert.equal(
        (yield* comments.list({ tripId: trip.trip_id })).rows.find(
          (row) => row.id === saved.id,
        )?.body,
        input.body,
      );
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});

test("older comments remain reachable with microsecond timestamp ties", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { tripComments: comments, sql } = yield* lakebaseFixture;
      for (let index = 0; index < 53; index++)
        yield* comments.add(
          { id: randomUUID(), trip, body: String(index) },
          author,
        );
      yield* sql`UPDATE app.trip_comments SET created_at='2026-11-14T10:00:00Z'::timestamptz + (body::int % 3) * INTERVAL '1 microsecond'`;
      assert.deepEqual(yield* comments.counts({ tripIds: [trip.trip_id] }), {
        [trip.trip_id]: 53,
      });
      const expected = yield* sql<{
        id: string;
      }>`SELECT id::text AS id FROM app.trip_comments ORDER BY created_at DESC, id DESC`;
      const ids: string[] = [];
      let search: TripCommentSearch = { tripId: trip.trip_id };
      for (let page = 0; ; page++) {
        assert.ok(page < 3, "cursor must advance");
        const result = yield* comments.list(search);
        ids.push(...result.rows.map((row) => row.id));
        if (!result.nextCursor) break;
        search = { tripId: trip.trip_id, cursor: result.nextCursor };
      }
      assert.deepEqual(
        ids,
        expected.map((row) => row.id),
      );
      assert.equal(new Set(ids).size, 53);
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});
