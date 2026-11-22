import { Schema } from "effect";
import { boundedText } from "./schema.js";
import { CursorPage } from "./cursor-page.js";
import { filteredSearch } from "./filters.js";

export const TripSort = Schema.Literals(["newest", "fare", "distance"]);
export const defaultTripLimit = 10_000;

export const Coordinates = Schema.Struct({
  longitude: Schema.Number.check(
    Schema.isBetween({ minimum: -180, maximum: 180 }),
  ),
  latitude: Schema.Number.check(
    Schema.isBetween({ minimum: -90, maximum: 90 }),
  ),
});

export const TripDetails = Schema.Struct({
  source_file: boundedText(160),
  vendor_id: Schema.NullOr(Schema.Int),
  passenger_count: Schema.NullOr(Schema.Int),
  rate_code_id: Schema.NullOr(Schema.Int),
  store_and_fwd_flag: Schema.NullOr(Schema.String),
  payment_type: Schema.NullOr(Schema.Int),
  pickup_location: Schema.NullOr(Coordinates),
  dropoff_location: Schema.NullOr(Coordinates),
  tip_amount: Schema.NullOr(Schema.Number),
  tolls_amount: Schema.NullOr(Schema.Number),
  extra: Schema.NullOr(Schema.Number),
  mta_tax: Schema.NullOr(Schema.Number),
  improvement_surcharge: Schema.NullOr(Schema.Number),
  total_amount: Schema.NullOr(Schema.Number),
});
export const TripSummary = Schema.Struct({
  trip_id: boundedText(256),
  pickup_at: boundedText(80),
  dropoff_at: boundedText(80),
  pickup_zip: boundedText(32),
  dropoff_zip: boundedText(32),
  distance: Schema.Number,
  fare: Schema.Number,
  duration: Schema.Number,
});
export type TripSummary = typeof TripSummary.Type;
export const TripSnapshot = Schema.Struct({
  ...TripSummary.fields,
  // Lakebase comments retain historical trip snapshots from before enrichment.
  details: Schema.optionalKey(TripDetails),
});
export type TripSnapshot = typeof TripSnapshot.Type;
export const Trip = Schema.Struct({
  ...TripSummary.fields,
  details: TripDetails,
});
export type Trip = typeof Trip.Type;

export const TripSearch = filteredSearch({
  sort: Schema.optionalKey(TripSort),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      // The warehouse fetches one extra row within Databricks SQL's INT range.
      Schema.isBetween({ minimum: 1, maximum: 2_147_483_646 }),
    ),
  ),
});
export type TripSearch = typeof TripSearch.Type;

export const TripPageCursor = boundedText(100).check(
  Schema.isPattern(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
);
export const TripPage = Schema.Struct({
  ...CursorPage(TripSummary, TripPageCursor).fields,
  hasMoreMatches: Schema.Boolean,
});
export type TripPage = typeof TripPage.Type;
