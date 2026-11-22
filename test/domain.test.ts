import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { GenieInput } from "../shared/genie.js";
import { SavedView, SavedViewInput } from "../shared/saved-views.js";
import { Day } from "../shared/schema.js";
import { Filters } from "../shared/filters.js";
import { TripSearch, type TripCursor } from "../shared/trips.js";

test("accepts real historical dates and rejects impossible dates", () => {
  assert.equal(Schema.decodeUnknownSync(Day)("2016-02-29"), "2016-02-29");
  for (const date of ["2016-02-30", "2026-02-29", "2016-13-01", "now"])
    assert.throws(() => Schema.decodeUnknownSync(Day)(date));
});
test("rejects unsafe filters and pagination before SQL execution", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(Filters)({ zip: "10001' OR 1=1" }),
  );
  assert.throws(() => Schema.decodeUnknownSync(TripSearch)({ cursor: "bad" }));
  assert.throws(() =>
    Schema.decodeUnknownSync(TripSearch)({ sort: "fare; DROP TABLE trips" }),
  );
});
test("trip cursors round-trip raw order keys and belong to one filter and sort", () => {
  const cursor: TripCursor = {
    filters: { zip: "10001", from: "2016-01-01", to: "2016-02-29" },
    sort: "fare",
    after: {
      trip_id: "trip-25",
      pickup_at: "2016-02-29 00:00:00.000001",
      dropoff_at: "2016-02-29 00:00:01.123456",
      pickup_zip: "10001",
      dropoff_zip: "Unknown",
      distance: 0,
      fare: 18.000000000000004,
    },
  };
  const query = { ...cursor.filters, sort: cursor.sort, cursor };
  const encoded = Schema.encodeSync(TripSearch)(query);
  assert.deepEqual(Schema.decodeUnknownSync(TripSearch)(encoded), query);
  for (const change of [
    { sort: "distance" },
    { zip: "10002" },
    { from: "2016-01-02" },
    { to: "2016-02-28" },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(TripSearch)({ ...encoded, ...change }),
    );
  }
  for (const after of [
    { pickup_at: "2016-02-30 12:00:00" },
    { dropoff_at: "2016-02-29 24:12:45" },
    { pickup_at: "2016-02-29 12:11:10.1234567" },
    { trip_id: "" },
    { distance: "2.3" },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(TripSearch)({
        ...encoded,
        cursor: JSON.stringify({
          ...cursor,
          after: { ...cursor.after, ...after },
        }),
      }),
    );
  }
});
test("bounds saved-view writes and conversational input", () => {
  const savedView = {
    id: "f9ca0a62-e2bc-4bc6-b27a-8c37cdd7d784",
    title: "A finding",
    body: "Finding",
    filters: { zip: "10001" },
    version: null,
  };
  assert.deepEqual(
    Schema.decodeUnknownSync(SavedViewInput)(savedView),
    savedView,
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(SavedViewInput)({
      ...savedView,
      id: "------------------------------------",
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(SavedViewInput)({
      ...savedView,
      body: "x".repeat(10001),
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(GenieInput)({
      content: "",
      conversationId: "x/y",
    }),
  );
});
test("accepts bounded page context and rejects oversized or unknown Genie views", () => {
  const input = {
    content: "Explain this chart",
    filters: {},
    context: { page: "overview", title: "Daily trips", data: '{"trips":12}' },
  };
  assert.deepEqual(Schema.decodeUnknownSync(GenieInput)(input), input);
  for (const context of [
    { ...input.context, page: "unknown" },
    { ...input.context, title: "" },
    { ...input.context, data: "x".repeat(24001) },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(GenieInput)({ ...input, context }),
    );
  }
});
test("date order is shared by analytics, trips, saved views, and Genie requests", () => {
  const savedView = {
    id: "f9ca0a62-e2bc-4bc6-b27a-8c37cdd7d784",
    title: "Finding",
    body: "",
    version: null,
  };
  for (const filters of [
    {},
    { from: "2016-01-10" },
    { to: "2016-01-10" },
    { from: "2016-01-10", to: "2016-01-10" },
    { from: "2016-01-10", to: "2016-01-20", zip: "10001" },
  ]) {
    assert.deepEqual(Schema.decodeUnknownSync(Filters)(filters), filters);
    assert.deepEqual(Schema.decodeUnknownSync(TripSearch)(filters), filters);
    assert.deepEqual(
      Schema.decodeUnknownSync(SavedViewInput)({ ...savedView, filters })
        .filters,
      filters,
    );
    assert.deepEqual(
      Schema.decodeUnknownSync(GenieInput)({ content: "Count", filters })
        .filters,
      filters,
    );
  }
  const reversed = { from: "2016-01-20", to: "2016-01-10" };
  assert.throws(() => Schema.decodeUnknownSync(Filters)(reversed));
  assert.throws(() => Schema.decodeUnknownSync(TripSearch)(reversed));
  assert.throws(() =>
    Schema.decodeUnknownSync(SavedViewInput)({
      ...savedView,
      filters: reversed,
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(SavedView)({
      ...savedView,
      version: 1,
      pinned: false,
      filters: reversed,
      created_at: "2026-11-13",
      updated_at: "2026-11-13",
    }),
  );
  for (const filters of [reversed, { zip: "bad" }, { from: "2016-02-30" }])
    assert.throws(() =>
      Schema.decodeUnknownSync(GenieInput)({ content: "Count", filters }),
    );
});
