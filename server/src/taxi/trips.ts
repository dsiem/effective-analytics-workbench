import { Effect, Schema, SchemaTransformation } from "effect";
import type { DatabricksClient } from "@dsiem/sql-warehouse";
import { Day } from "../../../shared/schema.js";
import {
  type Trip,
  TripDetails,
  type TripSort,
  TripSummary,
} from "../../../shared/trips.js";
import { TripNotFound } from "../errors.js";
import { type TaxiSnapshot, tripWhere } from "./snapshot.js";
import { makeTripPages } from "./trip-pages.js";

type Sql = DatabricksClient.DatabricksClient;

const tripZip = (sql: Sql, key: "pickup_zip" | "dropoff_zip") =>
  sql`COALESCE(CAST(${sql(key)} AS STRING), 'Unknown')`;

const tripSummaryProjection = (sql: Sql) => sql`
          CAST(trip_id AS STRING) AS trip_id,
          CAST(tpep_pickup_datetime AS STRING) AS pickup_at,
          CAST(tpep_dropoff_datetime AS STRING) AS dropoff_at,
          ${tripZip(sql, "pickup_zip")} AS pickup_zip,
          ${tripZip(sql, "dropoff_zip")} AS dropoff_zip,
          CAST(trip_distance AS DOUBLE) AS distance,
          CAST(fare_amount AS DOUBLE) AS fare,
          CAST(COALESCE(timestampdiff(SECOND,tpep_pickup_datetime,tpep_dropoff_datetime)/60.0,0) AS DOUBLE) AS duration`;

function tripPreviewWindow(
  sql: Sql,
  sort: typeof TripSort.Type,
  limit: number,
) {
  const metrics = { fare: sql`fare_amount`, distance: sql`trip_distance` };
  const order = [
    ...(sort === "newest" ? [] : [sql`${metrics[sort]} DESC NULLS LAST`]),
    sql`tpep_pickup_datetime DESC NULLS LAST`,
    sql`tpep_dropoff_datetime DESC NULLS LAST`,
    sql`${tripZip(sql, "pickup_zip")} ASC NULLS FIRST`,
    sql`${tripZip(sql, "dropoff_zip")} ASC NULLS FIRST`,
    ...(sort === "fare" ? [] : [sql`${metrics.fare} ASC NULLS FIRST`]),
    ...(sort === "distance" ? [] : [sql`${metrics.distance} ASC NULLS FIRST`]),
    sql`trip_id ASC`,
  ];
  return sql`ORDER BY ${sql.csv(order)} LIMIT ${sql.param("INT", String(limit + 1))}`;
}

const isDay = Schema.is(Day);
const TripTimestamp = TripSummary.fields.pickup_at.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/,
  ),
  Schema.makeFilter((value) => isDay(value.slice(0, 10))),
);
const NullableMeasure = Schema.NullOr(Schema.FiniteFromString).pipe(
  Schema.decodeTo(
    Schema.Finite,
    SchemaTransformation.transform({
      decode: (value) => value ?? 0,
      encode: (value) => value,
    }),
  ),
);
const WarehouseTripSummary = Schema.Struct({
  ...TripSummary.fields,
  pickup_at: TripTimestamp,
  dropoff_at: TripTimestamp,
  distance: NullableMeasure,
  fare: NullableMeasure,
  duration: Schema.FiniteFromString,
});

const WarehouseTrip = Schema.Struct({
  ...WarehouseTripSummary.fields,
  details: Schema.fromJsonString(TripDetails),
});

const tripDetailsProjection = (sql: Sql) =>
  sql`to_json(named_struct(
            'source_file', source_file, 'vendor_id', VendorID,
            'passenger_count', passenger_count, 'rate_code_id', RatecodeID,
            'store_and_fwd_flag', store_and_fwd_flag, 'payment_type', payment_type,
            'pickup_location', CASE WHEN pickup_coordinates_valid THEN named_struct('longitude', pickup_longitude, 'latitude', pickup_latitude) END,
            'dropoff_location', CASE WHEN dropoff_coordinates_valid THEN named_struct('longitude', dropoff_longitude, 'latitude', dropoff_latitude) END,
            'tip_amount', CASE WHEN abs(tip_amount) < double('Infinity') THEN tip_amount END,
            'tolls_amount', CASE WHEN abs(tolls_amount) < double('Infinity') THEN tolls_amount END,
            'extra', CASE WHEN abs(extra) < double('Infinity') THEN extra END,
            'mta_tax', CASE WHEN abs(mta_tax) < double('Infinity') THEN mta_tax END,
            'improvement_surcharge', CASE WHEN abs(improvement_surcharge) < double('Infinity') THEN improvement_surcharge END,
            'total_amount', CASE WHEN abs(total_amount) < double('Infinity') THEN total_amount END
          ), map('ignoreNullFields', 'false')) AS details`;

const decodeTripRows = Schema.decodeUnknownEffect(
  Schema.Array(WarehouseTripSummary),
);

export const makeTrips = (taxi: TaxiSnapshot) =>
  Effect.gen(function* () {
    const { trips, tripPage } = yield* makeTripPages(
      ({ limit, sort, ...filters }) =>
        Effect.gen(function* () {
          const { sql, snapshot, run } = yield* taxi;
          return yield* run(
            sql
              .jsonPage(
                sql`SELECT ${tripSummaryProjection(sql)}
              FROM ${snapshot} ${tripWhere(sql, filters)}
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
          );
        }),
    );
    const tripDetails = (tripId: Trip["trip_id"]) =>
      Effect.gen(function* () {
        const { sql, snapshot, read } = yield* taxi;
        const [row] = yield* read(
          WarehouseTrip,
          sql`SELECT ${tripSummaryProjection(sql)}, ${tripDetailsProjection(sql)}
            FROM ${snapshot} WHERE trip_id = ${tripId} LIMIT 1`,
        );
        return (
          row ??
          (yield* new TripNotFound({
            message: "This trip is no longer in the current snapshot.",
          }))
        );
      }).pipe(Effect.withSpan("analytics.tripDetails"));
    return { trips, tripPage, tripDetails };
  });
