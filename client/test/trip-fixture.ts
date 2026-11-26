import { Struct } from "effect";
import {
  TripSummary,
  type Trip,
  type TripPage,
} from "@dsiem/analytics-shared/trips";

export const tripDetails: Trip["details"] = {
  source_file: "test.csv",
  vendor_id: null,
  passenger_count: null,
  rate_code_id: null,
  store_and_fwd_flag: null,
  payment_type: null,
  pickup_location: null,
  dropoff_location: null,
  tip_amount: null,
  tolls_amount: null,
  extra: null,
  mta_tax: null,
  improvement_surcharge: null,
  total_amount: null,
};

export const tripSummaryFor = (trip: TripSummary) =>
  Struct.pick(trip, Struct.keys(TripSummary.fields));

export const fixtureCursor = "00000000-0000-4000-8000-000000000001.1";
export const fixtureContinuation = `/api/trips/pages/${fixtureCursor}`;

export function tripPreviewResponse(
  rows: readonly TripSummary[],
  hasMoreMatches = false,
  nextCursor: string | null = null,
) {
  return {
    json: {
      rows: rows.map(tripSummaryFor),
      nextCursor,
      hasMoreMatches,
    } satisfies TripPage,
  };
}

export const enrichedTrip: Trip = {
  trip_id: "stable-trip",
  pickup_at: "2016-01-01 10:00:00",
  dropoff_at: "2016-01-01 10:15:00",
  pickup_zip: "10001",
  dropoff_zip: "10019",
  distance: 3,
  fare: 12,
  duration: 15,
  details: {
    source_file: "yellow_tripdata_2016-01.csv.gz",
    vendor_id: 2,
    passenger_count: 1,
    rate_code_id: 1,
    store_and_fwd_flag: "N",
    payment_type: 2,
    pickup_location: { longitude: -73.99, latitude: 40.75 },
    dropoff_location: { longitude: -73.98, latitude: 40.76 },
    tip_amount: 0,
    tolls_amount: 2.5,
    extra: 0.5,
    mta_tax: 0.5,
    improvement_surcharge: 0.3,
    total_amount: 15.8,
  },
};
