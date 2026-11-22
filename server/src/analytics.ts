import { Cache, Context, Effect, Exit, Layer, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import {
  type AnalysisRunId,
  RouteReliabilityReport,
} from "../../shared/analysis-runs.js";
import {
  GpsCell,
  type GpsEndpoint,
  type GpsSearch,
  mapCellLimit,
  type TripMap,
} from "../../shared/map-dataset.js";
import {
  Daily,
  Hourly,
  type Overview,
  Summary,
  Zone,
} from "../../shared/overview.js";
import { type Filters } from "../../shared/filters.js";
import { DatasetMetadata } from "../../shared/dataset.js";
import type { TripSearch, Trips } from "../../shared/trips.js";
import {
  type ServiceUnavailable,
  type OperationTimeout,
  type PermissionDenied,
  unavailable,
} from "./errors.js";
import { Settings } from "./settings.js";
import {
  formatTripPage,
  tripPageWindow,
  tripZip,
  WarehouseTrip,
} from "./trip-pagination.js";
import { tripDetailsProjection } from "./trip-sql.js";
import { makeWarehouse } from "./warehouse.js";

type WarehouseError = ServiceUnavailable | OperationTimeout | PermissionDenied;

export class Analytics extends Context.Service<
  Analytics,
  {
    readonly metadata: Effect.Effect<
      typeof DatasetMetadata.Type,
      WarehouseError
    >;
    readonly overview: (
      filters: Filters,
    ) => Effect.Effect<Overview, WarehouseError>;
    readonly trips: (
      search: TripSearch,
    ) => Effect.Effect<typeof Trips.Type, WarehouseError>;
    readonly tripMap: (
      search: typeof GpsSearch.Type,
    ) => Effect.Effect<TripMap, WarehouseError>;
    readonly analysisReport: (
      id: AnalysisRunId,
    ) => Effect.Effect<typeof RouteReliabilityReport.Type, WarehouseError>;
  }
>()("app/Analytics") {
  static readonly layer = Layer.effect(
    Analytics,
    Effect.gen(function* () {
      const { sql, snapshot, read, error } = yield* makeWarehouse;
      const { analysisResultsTable } = yield* Settings;
      const analysisReport = (id: AnalysisRunId) => {
        const [catalog, schema, table] = analysisResultsTable.split(".");
        if (!catalog || !schema || !table)
          return Effect.fail(
            unavailable("analysis", "Configure the analysis results table."),
          );
        return read(
          Schema.Struct({
            report_json: Schema.fromJsonString(RouteReliabilityReport),
          }),
          sql`SELECT report_json FROM ${sql(catalog)}.${sql(schema)}.${sql(table)}
              WHERE run_id = CAST(${String(id)} AS BIGINT) LIMIT 1`,
          "This report is under lock. You need permission to read it.",
        ).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ServiceUnavailable"
              ? unavailable(
                  "analysis",
                  "The report could not be read. Check SELECT access to the results table.",
                  cause,
                )
              : cause,
          ),
          Effect.flatMap(([row]) =>
            row
              ? Effect.succeed(row.report_json)
              : Effect.fail(
                  unavailable(
                    "analysis",
                    "The completed report is missing. Check the job's results table.",
                  ),
                ),
          ),
        );
      };
      const where = (filters: Filters) => sql`WHERE 1 = 1
      ${filters.from ? sql`AND tpep_pickup_datetime >= CAST(${filters.from} AS TIMESTAMP)` : sql``}
      ${filters.to ? sql`AND tpep_pickup_datetime < CAST(${filters.to} AS TIMESTAMP) + INTERVAL 1 DAY` : sql``}
      ${filters.zip ? sql`AND CAST(pickup_zip AS STRING) = ${filters.zip}` : sql``}`;

      const metadataCache = yield* Cache.makeWith(
        (_key: "dataset") =>
          read(
            DatasetMetadata,
            sql`SELECT
      CAST(MIN(tpep_pickup_datetime) AS DATE)::STRING AS from,
      CAST(MAX(tpep_pickup_datetime) AS DATE)::STRING AS to,
      CAST(COUNT(*) AS DOUBLE) AS trips FROM ${snapshot}`,
          ).pipe(
            Effect.flatMap((rows) =>
              rows[0] ? Effect.succeed(rows[0]) : Effect.fail(error),
            ),
          ),
        {
          capacity: 1,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
        },
      );
      const metadata = Cache.get(metadataCache, "dataset");
      const overviewCache = yield* Cache.makeWith(
        (filters: Filters) => {
          const predicate = where(filters);
          return Effect.all(
            {
              summary: read(
                Summary,
                sql`SELECT CAST(COUNT(*) AS DOUBLE) AS trips,
          CAST(COALESCE(SUM(fare_amount), 0) AS DOUBLE) AS revenue,
          CAST(COALESCE(AVG(fare_amount), 0) AS DOUBLE) AS avg_fare,
          CAST(COALESCE(AVG(trip_distance), 0) AS DOUBLE) AS avg_distance,
          CAST(COALESCE(AVG(timestampdiff(SECOND, tpep_pickup_datetime, tpep_dropoff_datetime) / 60.0), 0) AS DOUBLE) AS avg_duration
          FROM ${snapshot} ${predicate}`,
              ).pipe(
                Effect.map(
                  (rows) =>
                    rows[0] ?? {
                      trips: 0,
                      revenue: 0,
                      avg_fare: 0,
                      avg_distance: 0,
                      avg_duration: 0,
                    },
                ),
              ),
              daily: read(
                Daily,
                sql`SELECT CAST(CAST(tpep_pickup_datetime AS DATE) AS STRING) AS day,
          CAST(COUNT(*) AS DOUBLE) AS trips, CAST(COALESCE(SUM(fare_amount),0) AS DOUBLE) AS revenue
          FROM ${snapshot} ${predicate} GROUP BY 1 ORDER BY 1`,
              ),
              hourly: read(
                Hourly,
                sql`SELECT CAST(HOUR(tpep_pickup_datetime) AS DOUBLE) AS hour,
          CAST(COUNT(*) AS DOUBLE) AS trips, CAST(COALESCE(AVG(fare_amount),0) AS DOUBLE) AS avg_fare
          FROM ${snapshot} ${predicate} GROUP BY 1 ORDER BY 1`,
              ),
              zones: read(
                Zone,
                sql`SELECT COALESCE(CAST(pickup_zip AS STRING), 'Unknown') AS zip,
          CAST(COUNT(*) AS DOUBLE) AS trips, CAST(COALESCE(SUM(fare_amount),0) AS DOUBLE) AS revenue,
          CAST(COALESCE(AVG(fare_amount),0) AS DOUBLE) AS avg_fare
          FROM ${snapshot} ${predicate} GROUP BY 1 ORDER BY trips DESC`,
              ),
            },
            { concurrency: 3 },
          ).pipe(
            Effect.map((data) => ({
              ...data,
              queriedAt: new Date().toISOString(),
            })),
            Effect.withSpan("analytics.overview"),
          );
        },
        {
          capacity: 64,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? "60 seconds" : 0),
        },
      );

      const trips = (search: TripSearch) => {
        const { sort = "newest", cursor, ...filters } = search;
        const predicate = where(filters);
        return Effect.all(
          {
            rows: read(
              WarehouseTrip,
              sql`SELECT CAST(trip_id AS STRING) AS trip_id,
          CAST(tpep_pickup_datetime AS STRING) AS pickup_at,
          CAST(tpep_dropoff_datetime AS STRING) AS dropoff_at,
          ${tripZip(sql, "pickup_zip")} AS pickup_zip,
          ${tripZip(sql, "dropoff_zip")} AS dropoff_zip,
          CAST(trip_distance AS DOUBLE) AS distance,
          CAST(fare_amount AS DOUBLE) AS fare,
          CAST(COALESCE(timestampdiff(SECOND,tpep_pickup_datetime,tpep_dropoff_datetime)/60.0,0) AS DOUBLE) AS duration,
          ${tripDetailsProjection(sql)}
          FROM ${snapshot} ${predicate}
          ${tripPageWindow(sql, sort, cursor?.after)}`,
            ),
            total: read(
              Schema.Struct({ total: Schema.Number }),
              sql`SELECT CAST(COUNT(*) AS DOUBLE) AS total FROM ${snapshot} ${predicate}`,
            ).pipe(Effect.map((rows) => rows[0]?.total ?? 0)),
          },
          { concurrency: 2 },
        ).pipe(
          Effect.map(({ rows, total }) =>
            formatTripPage(rows, total, { sort, filters }),
          ),
          Effect.withSpan("analytics.trips"),
        );
      };
      const gpsCache = yield* Cache.makeWith(
        (search: Filters & { readonly endpoint: GpsEndpoint }) => {
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
          return Effect.all(
            {
              totals: read(
                Schema.Struct({
                  matching: Schema.Number,
                  located: Schema.Number,
                }),
                sql`SELECT COUNT(*)::DOUBLE AS matching, count_if(${valid})::DOUBLE AS located FROM ${snapshot} ${where(search)}`,
              ),
              cells: read(
                Schema.Struct({
                  ...GpsCell.fields,
                  boundary: Schema.fromJsonString(GpsCell.fields.boundary),
                  total_cells: Schema.Number,
                }),
                sql`WITH bins AS (
            SELECT h3_longlatash3(${longitude}, ${latitude}, 10) AS cell,
              COUNT(*)::DOUBLE AS trips, AVG(fare_amount) AS avg_fare,
              AVG(trip_distance) AS avg_distance, mode(${zip}, true) AS zip
            FROM ${snapshot} ${where(search)} AND ${valid} GROUP BY 1
          ) SELECT h3_h3tostring(cell) AS id,
            (h3_centerasgeojson(cell):coordinates[0])::DOUBLE AS longitude,
            (h3_centerasgeojson(cell):coordinates[1])::DOUBLE AS latitude,
            h3_boundaryasgeojson(cell) AS boundary, trips, avg_fare, avg_distance, zip,
            COUNT(*) OVER()::DOUBLE AS total_cells
          FROM bins ORDER BY trips DESC, cell LIMIT ${sql.param("INT", String(mapCellLimit))}`,
              ),
            },
            { concurrency: 2 },
          ).pipe(
            Effect.map(({ totals, cells }): TripMap => {
              const totalCells = cells[0]?.total_cells ?? 0;
              return {
                endpoint,
                matchingTrips: totals[0]?.matching ?? 0,
                locatedTrips: totals[0]?.located ?? 0,
                shownTrips: cells.reduce((sum, cell) => sum + cell.trips, 0),
                totalCells,
                truncated: cells.length < totalCells,
                cells: cells.map(({ total_cells: _, ...cell }) => cell),
                queriedAt: new Date().toISOString(),
              };
            }),
          );
        },
        {
          capacity: 16,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
        },
      );
      return {
        metadata,
        analysisReport,
        overview: (filters: Filters) => Cache.get(overviewCache, filters),
        trips,
        tripMap: (search: typeof GpsSearch.Type) =>
          Cache.get(gpsCache, {
            ...search,
            endpoint: search.endpoint ?? "pickup",
          }),
      };
    }).pipe(Effect.provide(Reactivity.layer)),
  );
}
