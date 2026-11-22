import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { GenieInput } from "../../shared/genie";
import { Trip } from "../../shared/trips";
import { tripsContext } from "../src/features/trips/context";
import { init } from "../src/features/trips/model";
import { tripDetails } from "./trip-fixture";

test("Genie accepts a five-row trip sample with maximum-length fields and large enrichment", () => {
  const rows = Array.from({ length: 25 }, (_, index) =>
    Trip.make({
      trip_id: "\u0000".repeat(254) + String(index).padStart(2, "0"),
      pickup_at: "\u0001".repeat(80),
      dropoff_at: "🚕".repeat(40),
      pickup_zip: "\u0002".repeat(32),
      dropoff_zip: "\u0003".repeat(32),
      distance: 1.5,
      duration: 12,
      fare: 13.42,
      details: { ...tripDetails, store_and_fwd_flag: "x".repeat(25_000) },
    }),
  );
  const data = { rows, total: 500, pageSize: 25, nextCursor: null };
  const filters = { zip: "10001" };
  for (const selectedTrip of [null, rows.at(-1) ?? null]) {
    const context = tripsContext(
      { ...init(), selectedTrip, trips: { data, loading: false, error: "" } },
      { filters, sort: "fare" },
    );
    assert.ok(
      Schema.is(GenieInput)({
        content: "Compare these trips",
        filters,
        context,
      }),
    );
    assert.ok(context.data);
    assert.deepEqual(JSON.parse(context.data), {
      page: 1,
      sort: "fare",
      totalMatchingTrips: 500,
      pageSize: 25,
      filters,
      scope: "page-subset",
      selectedTripId: selectedTrip?.trip_id ?? null,
      visibleCount: 25,
      visibleSample: rows
        .slice(0, 5)
        .map(({ details: _, ...columns }) => columns),
    });
  }
});
