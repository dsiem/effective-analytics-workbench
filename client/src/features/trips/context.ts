import { Struct } from "effect";
import type { GenieContext } from "../../../../shared/genie";
import type { Filters } from "../../../../shared/filters";
import { type Model, type Sort, tripPageNumber } from "./model";

export function tripsContext(
  state: Model,
  { filters, sort }: { filters: Filters | null; sort: typeof Sort.Type },
): GenieContext {
  const trips = state.trips.data;
  const page = tripPageNumber(state);
  const context: GenieContext = {
    page: "trips",
    title: `Trip records · page ${page}`,
  };
  if (!trips || state.trips.loading || state.trips.error) return context;
  return {
    ...context,
    data: JSON.stringify({
      page,
      sort,
      totalMatchingTrips: trips.total,
      pageSize: trips.pageSize,
      filters,
      scope: "page-subset",
      selectedTripId: state.selectedTrip?.trip_id ?? null,
      visibleCount: trips.rows.length,
      visibleSample: trips.rows
        .slice(0, 5)
        .map((trip) =>
          Struct.pick(trip, [
            "trip_id",
            "pickup_at",
            "dropoff_at",
            "pickup_zip",
            "dropoff_zip",
            "distance",
            "duration",
            "fare",
          ]),
        ),
    }),
  };
}
