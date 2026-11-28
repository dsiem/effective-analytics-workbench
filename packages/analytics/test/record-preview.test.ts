import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { makeRecordPreview } from "../src/record-preview.js";

test("a repair list follows cursors within the requested limit and reuses small previews", async () => {
  const repairs = ["repair-1", "repair-2", "repair-3", "repair-4"].map(
    (ticket) => ({ ticket }),
  );
  let starts = 0;
  let reads = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const previews = yield* makeRecordPreview({
        start: ({ limit }: { limit: number }) =>
          Effect.sync(() => {
            starts++;
            const selected = repairs.slice(0, limit);
            return {
              rows: selected.slice(0, 2),
              pageCount: Math.ceil(selected.length / 2),
              truncated: selected.length < repairs.length,
              readChunk: (_index: number, offset: number) =>
                Effect.sync(() => {
                  reads++;
                  return selected.slice(offset, offset + 2);
                }),
            };
          }),
        encodePage: ({ rows, nextCursor, hasMoreMatches }) =>
          Effect.succeed({
            tickets: rows.map((row) => row.ticket),
            after: nextCursor,
            more: hasMoreMatches,
          }),
        cacheable: ({ limit }) => limit <= 3,
        invalidCursor: () => "expired" as const,
        inconsistentPage: () => "inconsistent" as const,
      });
      const first = yield* previews.open({ limit: 3 });
      assert.deepEqual(first.tickets, ["repair-1", "repair-2"]);
      assert.equal(first.more, true);
      assert.ok(first.after);
      assert.equal(reads, 0);
      assert.deepEqual(yield* previews.open({ limit: 3 }), first);
      assert.equal(starts, 1);
      assert.deepEqual(yield* previews.page(first.after), {
        tickets: ["repair-3"],
        after: null,
        more: true,
      });
      const large = yield* previews.open({ limit: 4 });
      assert.equal(large.more, false);
      assert.ok(large.after);
      assert.deepEqual(yield* previews.page(large.after), {
        tickets: ["repair-3", "repair-4"],
        after: null,
        more: false,
      });
      const fresh = yield* previews.open({ limit: 4 });
      assert.notEqual(fresh.after, large.after);
      assert.equal(starts, 3);
      yield* TestClock.adjust("16 minutes");
      assert.equal(yield* Effect.flip(previews.page(first.after)), "expired");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
