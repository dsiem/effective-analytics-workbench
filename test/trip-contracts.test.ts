import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AppApi } from "../shared/api.js";
import {
  TripCommentInput,
  TripCommentSearch,
} from "../shared/trip-comments.js";
import { Trip, TripSnapshot } from "../shared/trips.js";

const historical: TripSnapshot = {
  trip_id: "00000000-0000-4000-8000-000000000001",
  pickup_at: "2016-01-01 10:00:00",
  dropoff_at: "2016-01-01 10:10:00",
  pickup_zip: "10001",
  dropoff_zip: "Unknown",
  distance: 2,
  fare: 10,
  duration: 10,
};
const current: Trip = {
  ...historical,
  details: {
    source_file: "test.csv",
    vendor_id: null,
    passenger_count: null,
    rate_code_id: null,
    store_and_fwd_flag: null,
    payment_type: null,
    pickup_location: null,
    dropoff_location: null,
    tip_amount: 0,
    tolls_amount: null,
    extra: null,
    mta_tax: null,
    improvement_surcharge: null,
    total_amount: null,
  },
};

test("historical comment snapshots remain valid without current enrichment", () => {
  const input = {
    id: "00000000-0000-4000-8000-000000000002",
    body: "Historical finding",
    trip: historical,
  };
  assert.deepEqual(Schema.decodeUnknownSync(TripCommentInput)(input), input);
  assert.deepEqual(
    Schema.decodeUnknownSync(TripCommentSearch)({
      tripId: historical.trip_id,
    }).tripId,
    historical.trip_id,
  );
  assert.deepEqual(Schema.decodeUnknownSync(Trip)(current), current);
  assert.throws(() => Schema.decodeUnknownSync(Trip)(historical));
});

const fixtureClient = (body: unknown) =>
  Effect.runSync(
    HttpApiClient.make(AppApi, { baseUrl: "http://fixture.test" }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, async () =>
        Response.json(body),
      ),
    ),
  );

for (const enriched of [false, true]) {
  test(`trip detail HTTP responses ${enriched ? "accept" : "reject missing"} enrichment`, async () => {
    const trip = enriched ? current : historical;
    const client = fixtureClient(trip);
    const result = await Effect.runPromise(
      Effect.result(
        client.analytics.tripDetails({ query: { tripId: trip.trip_id } }),
      ),
    );
    assert.equal(result._tag, enriched ? "Success" : "Failure");
    if (result._tag === "Failure")
      assert.ok(Schema.isSchemaError(result.failure));
  });
}
