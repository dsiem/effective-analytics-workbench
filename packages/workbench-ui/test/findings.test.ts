import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Schema } from "effect";
import { makeFindingsFeature } from "../src/findings.js";

test("a completed search cannot replace findings from a later search", () => {
  const feature = makeFindingsFeature({
    filters: Schema.Struct({ station: Schema.String }),
    newFilters: Effect.succeed({ station: "Ridge" }),
    list: () => Effect.succeed({ rows: [], nextCursor: null }),
    save: () => Effect.die("unused"),
    pin: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    describe: (filters) => filters.station,
    href: (filters) => "/?station=" + filters.station,
  });
  const first = feature.init().model;
  const second = feature.update(
    first,
    feature.Message.Search({ value: "Celsius" }),
  ).model;
  const stale = feature.update(
    second,
    feature.Message.ListFailed({
      generation: first.generation,
      reason: "Late error",
    }),
  ).model;
  assert.equal(stale.loading, true);
  assert.equal(stale.listError, "");
  const current = feature.update(
    stale,
    feature.Message.Listed({
      generation: second.generation,
      more: false,
      page: { rows: [], nextCursor: null },
    }),
  ).model;
  assert.equal(current.search, "Celsius");
  assert.equal(current.loading, false);
});
