import { Struct } from "effect";
import { TripSummary, type Trip, type TripPage } from "../../shared/trips";

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
