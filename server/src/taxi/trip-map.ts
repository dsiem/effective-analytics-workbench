import { Cache, DateTime, Effect, Exit, Schema, Stream } from "effect";
import type { Filters } from "@dsiem/analytics-shared/filters";
import {
  GpsCell,
  type GpsEndpoint,
  type GpsSearch,
  mapCellLimit,
  TripMap,
} from "@dsiem/analytics-shared/map-dataset";
import { type TaxiSnapshot, tripWhere } from "./snapshot.js";

export const makeTripMap = (taxi: TaxiSnapshot) =>
  Effect.gen(function* () {
    const gpsCache = yield* Cache.makeWith(
      (search: Filters & { readonly endpoint: GpsEndpoint }) =>
        Effect.gen(function* () {
          const { sql, snapshot, read } = yield* taxi;
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
                sql`SELECT COUNT(*)::DOUBLE AS matching, count_if(${valid})::DOUBLE AS located FROM ${snapshot} ${tripWhere(sql, search)}`,
              ),
              cells: read(
                Schema.Struct({
                  ...GpsCell.fields,
                  boundary: Schema.fromJsonString(GpsCell.fields.boundary),
                  total_cells: TripMap.fields.totalCells,
                }),
                sql
                  .arrowStream(sql`WITH bins AS (
            SELECT h3_longlatash3(${longitude}, ${latitude}, 10) AS cell,
              COUNT(*)::DOUBLE AS trips, AVG(fare_amount) AS avg_fare,
              AVG(trip_distance) AS avg_distance, mode(${zip}, true) AS zip
            FROM ${snapshot} ${tripWhere(sql, search)} AND ${valid} GROUP BY 1
          ) SELECT h3_h3tostring(cell) AS id,
            (h3_centerasgeojson(cell):coordinates[0])::DOUBLE AS longitude,
            (h3_centerasgeojson(cell):coordinates[1])::DOUBLE AS latitude,
            h3_boundaryasgeojson(cell) AS boundary, trips, avg_fare, avg_distance, zip,
            COUNT(*) OVER()::DOUBLE AS total_cells
          FROM bins ORDER BY trips DESC, cell LIMIT ${sql.param("INT", String(mapCellLimit))}`)
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
