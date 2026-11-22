import { Schema } from "effect";
import { CursorPage } from "./cursor-page.js";
import { boundedText, Day } from "./schema.js";
import { Filters, filteredSearch, sameFilters } from "./filters.js";

export const TripSort = Schema.Literals(["newest", "fare", "distance"]);

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
export const TripSnapshot = Schema.Struct({
  trip_id: boundedText(256),
  pickup_at: boundedText(80),
  dropoff_at: boundedText(80),
  pickup_zip: boundedText(32),
  dropoff_zip: boundedText(32),
  distance: Schema.Number,
  fare: Schema.Number,
  duration: Schema.Number,
  // Lakebase comments retain historical trip snapshots from before enrichment.
  details: Schema.optionalKey(TripDetails),
});
export type TripSnapshot = typeof TripSnapshot.Type;
export const Trip = Schema.Struct({
  ...TripSnapshot.fields,
  details: TripDetails,
});
export type Trip = typeof Trip.Type;

const isDay = Schema.is(Day);
const cursorTimestamp = TripSnapshot.fields.pickup_at.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/,
  ),
  Schema.makeFilter((value) => isDay(value.slice(0, 10))),
);
export const TripPosition = Schema.Struct({
  trip_id: TripSnapshot.fields.trip_id,
  pickup_at: cursorTimestamp,
  dropoff_at: cursorTimestamp,
  pickup_zip: TripSnapshot.fields.pickup_zip,
  dropoff_zip: TripSnapshot.fields.dropoff_zip,
  fare: Schema.NullOr(Schema.Finite),
  distance: Schema.NullOr(Schema.Finite),
});
export type TripPosition = typeof TripPosition.Type;
export const TripCursor = Schema.Struct({
  filters: Filters,
  sort: TripSort,
  after: TripPosition,
});
export type TripCursor = typeof TripCursor.Type;

export const TripSearch = filteredSearch({
  sort: Schema.optionalKey(TripSort),
  cursor: Schema.optionalKey(Schema.fromJsonString(TripCursor)),
}).check(
  Schema.makeFilter((search) => {
    const { cursor, sort = "newest" } = search;
    return (
      !cursor ||
      (cursor.sort === sort && sameFilters(cursor.filters, search)) ||
      "The trip cursor must match the filters and sort order."
    );
  }),
);
export type TripSearch = typeof TripSearch.Type;

export const tripPageSize = 25;
export const Trips = Schema.Struct({
  ...CursorPage(Trip, TripCursor).fields,
  total: Schema.Number,
  pageSize: Schema.Number,
});
