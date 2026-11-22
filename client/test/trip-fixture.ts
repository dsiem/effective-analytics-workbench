import { Struct } from "effect";
import type { Filters } from "../../shared/filters";
import { TripPosition, type Trip, type TripCursor } from "../../shared/trips";

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

export function tripCursorFor(
  trip: Trip,
  filters: Filters,
  sort: TripCursor["sort"] = "newest",
): TripCursor {
  return {
    filters,
    sort,
    after: Struct.pick(trip, Struct.keys(TripPosition.fields)),
  };
}
