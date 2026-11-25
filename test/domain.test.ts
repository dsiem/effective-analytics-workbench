import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { GenieInput } from "@dsiem/analytics-shared/genie";
import { SavedView, SavedViewInput } from "@dsiem/analytics-shared/saved-views";
import { Day } from "@dsiem/analytics-shared/schema";
import { Filters } from "@dsiem/analytics-shared/filters";
import { TripSearch } from "@dsiem/analytics-shared/trips";

test("accepts real historical dates and rejects impossible dates", () => {
  assert.equal(Schema.decodeUnknownSync(Day)("2016-02-29"), "2016-02-29");
  for (const date of ["2016-02-30", "2026-02-29", "2016-13-01", "now"])
    assert.throws(() => Schema.decodeUnknownSync(Day)(date));
});
test("rejects unsafe filters and sort values before SQL execution", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(Filters)({ zip: "10001' OR 1=1" }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(TripSearch)({ sort: "fare; DROP TABLE trips" }),
  );
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
