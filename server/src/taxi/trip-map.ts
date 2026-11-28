import { Cache, DateTime, Effect, Exit, Schema, Stream } from "effect";
import { h3Cells } from "@dsiem/analytics/spark";
import type { Filters } from "@dsiem/analytics-shared/filters";
import {
  GpsCell,
  type GpsEndpoint,
  type GpsSearch,
  mapCellLimit,
  TripMap,
} from "@dsiem/analytics-shared/map-dataset";
import type { TaxiSnapshot } from "./snapshot.js";

export const makeTripMap = (taxi: TaxiSnapshot) =>
  Effect.gen(function* () {
    const gpsCache = yield* Cache.makeWith(
      (search: Filters & { readonly endpoint: GpsEndpoint }) =>
        Effect.gen(function* () {
          const { sql, source, read } = yield* taxi;
          const { endpoint } = search;
          const longitude =
            endpoint === "pickup"
              ? sql`pickup_longitude`
              : sql`dropoff_longitude`;
          const latitude =
            endpoint === "pickup"
              ? sql`pickup_latitude`
              : sql`dropoff_latitude`;
          const valid =
            endpoint === "pickup"
              ? sql`pickup_coordinates_valid`
              : sql`dropoff_coordinates_valid`;
          const zip =
            endpoint === "pickup" ? sql`pickup_zip` : sql`dropoff_zip`;
          const { totals, cells } = yield* Effect.all(
            {
              totals: read(
                Schema.toCodecStringTree(
                  Schema.Struct({
                    matching: TripMap.fields.matchingTrips,
                    located: TripMap.fields.locatedTrips,
                  }),
                ),
                source.aggregate({
                  filters: search,
                  measures: {
                    matching: sql`COUNT(*)::DOUBLE`,
                    located: sql`count_if(${valid})::DOUBLE`,
                  },
                }),
              ),
              cells: read(
                Schema.Struct({
                  ...GpsCell.fields,
                  boundary: Schema.fromJsonString(GpsCell.fields.boundary),
                  total_cells: TripMap.fields.totalCells,
                }),
                sql
                  .arrowStream(
                    h3Cells(sql, source, {
                      filters: search,
                      longitude,
                      latitude,
                      where: valid,
                      resolution: 10,
                      measures: {
                        trips: sql`COUNT(*)::DOUBLE`,
                        avg_fare: sql`AVG(fare_amount)`,
                        avg_distance: sql`AVG(trip_distance)`,
                        zip: sql`mode(${zip}, true)`,
                      },
                      rankBy: { measure: "trips", direction: "desc" },
                      limit: mapCellLimit,
                    }),
                  )
                  .pipe(
                    Stream.flatMap((batch) => Stream.fromIterable(batch)),
                    Stream.map((row) => row.toJSON()),
                    Stream.runCollect,
                  ),
              ),
            },
            { concurrency: 2 },
          );
          const now = yield* DateTime.now;
          const totalCells = cells[0]?.total_cells ?? 0;
          return {
            endpoint,
            matchingTrips: totals[0]?.matching ?? 0,
            locatedTrips: totals[0]?.located ?? 0,
            shownTrips: cells.reduce((sum, cell) => sum + cell.trips, 0),
            totalCells,
            truncated: cells.length < totalCells,
            cells: cells.map(({ total_cells: _, ...cell }) => cell),
            queriedAt: DateTime.formatIso(now),
          } satisfies TripMap;
        }),
      {
        capacity: 16,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
      },
    );
    return (search: typeof GpsSearch.Type) =>
      Cache.get(gpsCache, {
        ...search,
        endpoint: search.endpoint ?? "pickup",
      });
  });
