import { Cache, Context, Effect, Exit, Layer, Schema, Stream } from "effect";
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
import { type Trip, type TripSearch } from "../../shared/trips.js";
import {
  type InvalidRequest,
  type ServiceUnavailable,
  type OperationTimeout,
  type PermissionDenied,
  TripNotFound,
} from "./errors.js";
import {
  tripDetailsProjection,
  tripPreviewWindow,
  tripSummaryProjection,
  WarehouseTrip,
  WarehouseTripSummary,
} from "./trip-sql.js";
import { makeTripPages } from "./trip-pages.js";
import { Warehouse } from "./warehouse.js";

type WarehouseError = ServiceUnavailable | OperationTimeout | PermissionDenied;
const decodeTripRows = Schema.decodeUnknownEffect(
  Schema.Array(WarehouseTripSummary),
);
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
    ) => Effect.Effect<Uint8Array, WarehouseError>;
    readonly tripPage: (
      cursor: string,
    ) => Effect.Effect<Uint8Array, WarehouseError | InvalidRequest>;
    readonly tripDetails: (
      tripId: Trip["trip_id"],
    ) => Effect.Effect<Trip, WarehouseError | TripNotFound>;
    readonly tripMap: (
      search: typeof GpsSearch.Type,
    ) => Effect.Effect<TripMap, WarehouseError>;
  }
>()("app/Analytics") {
  static readonly layer = Layer.effect(
    Analytics,
    Effect.gen(function* () {
      const { sql, snapshot, read, run, error } = yield* Warehouse;
      const where = (filters: Filters) => sql`WHERE 1 = 1
      ${filters.from ? sql`AND tpep_pickup_datetime >= CAST(${filters.from} AS TIMESTAMP)` : sql``}
      ${filters.to ? sql`AND tpep_pickup_datetime < CAST(${filters.to} AS TIMESTAMP) + INTERVAL 1 DAY` : sql``}
      ${filters.zip ? sql`AND CAST(pickup_zip AS STRING) = ${filters.zip}` : sql``}`;

      const metadataCache = yield* Cache.makeWith(
        (_key: "dataset") =>
          read(
            Schema.toCodecStringTree(DatasetMetadata),
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
                Schema.toCodecStringTree(Summary),
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
                Schema.toCodecStringTree(Daily),
                sql`SELECT CAST(CAST(tpep_pickup_datetime AS DATE) AS STRING) AS day,
          CAST(COUNT(*) AS DOUBLE) AS trips, CAST(COALESCE(SUM(fare_amount),0) AS DOUBLE) AS revenue
          FROM ${snapshot} ${predicate} GROUP BY 1 ORDER BY 1`,
              ),
              hourly: read(
                Schema.toCodecStringTree(Hourly),
                sql`SELECT CAST(HOUR(tpep_pickup_datetime) AS DOUBLE) AS hour,
          CAST(COUNT(*) AS DOUBLE) AS trips, CAST(COALESCE(AVG(fare_amount),0) AS DOUBLE) AS avg_fare
          FROM ${snapshot} ${predicate} GROUP BY 1 ORDER BY 1`,
              ),
              zones: read(
                Schema.toCodecStringTree(Zone),
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

      const { trips, tripPage } = yield* makeTripPages(
        ({ limit, sort, ...filters }) =>
          run(
            sql
              .jsonPage(
                sql`SELECT ${tripSummaryProjection(sql)}
              FROM ${snapshot} ${where(filters)}
              ${tripPreviewWindow(sql, sort, limit)}`,
                { rowLimit: limit },
              )
              .pipe(
                Effect.flatMap(({ rows, pageCount, truncated, readChunk }) =>
                  Effect.map(decodeTripRows(rows), (rows) => ({
                    rows,
                    pageCount,
                    truncated,
                    readChunk: (index: number, offset: number) =>
                      run(
                        readChunk(index, offset).pipe(
                          Effect.flatMap(decodeTripRows),
                        ),
                      ),
                  })),
                ),
              ),
          ),
      );
      const tripDetails = (tripId: Trip["trip_id"]) =>
        read(
          WarehouseTrip,
          sql`SELECT ${tripSummaryProjection(sql)}, ${tripDetailsProjection(sql)}
            FROM ${snapshot} WHERE trip_id = ${tripId} LIMIT 1`,
        ).pipe(
          Effect.flatMap(([row]) =>
            row
              ? Effect.succeed(row)
              : Effect.fail(
                  new TripNotFound({
                    message: "This trip is no longer in the current snapshot.",
                  }),
                ),
          ),
          Effect.withSpan("analytics.tripDetails"),
        );
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
                  matching: Schema.NumberFromString,
                  located: Schema.NumberFromString,
                }),
                sql`SELECT COUNT(*)::DOUBLE AS matching, count_if(${valid})::DOUBLE AS located FROM ${snapshot} ${where(search)}`,
              ),
              cells: read(
                Schema.Struct({
                  ...GpsCell.fields,
                  boundary: Schema.fromJsonString(GpsCell.fields.boundary),
                  total_cells: Schema.Number,
                }),
                sql
                  .arrowStream(sql`WITH bins AS (
            SELECT h3_longlatash3(${longitude}, ${latitude}, 10) AS cell,
              COUNT(*)::DOUBLE AS trips, AVG(fare_amount) AS avg_fare,
              AVG(trip_distance) AS avg_distance, mode(${zip}, true) AS zip
            FROM ${snapshot} ${where(search)} AND ${valid} GROUP BY 1
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
        overview: (filters: Filters) => Cache.get(overviewCache, filters),
        trips,
        tripPage,
        tripDetails,
        tripMap: (search: typeof GpsSearch.Type) =>
          Cache.get(gpsCache, {
            ...search,
            endpoint: search.endpoint ?? "pickup",
          }),
      };
    }),
  );
}
