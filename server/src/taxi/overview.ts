import { Cache, DateTime, Effect, Exit, Schema } from "effect";
import { DatasetMetadata } from "@dsiem/analytics-shared/dataset";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { Daily, Hourly, Summary, Zone } from "@dsiem/analytics-shared/overview";
import {
  taxiQueryUnavailable,
  type TaxiSnapshot,
  tripWhere,
} from "./snapshot.js";

export const makeOverview = (taxi: TaxiSnapshot) =>
  Effect.gen(function* () {
    const metadataCache = yield* Cache.makeWith(
      (_key: "dataset") =>
        Effect.gen(function* () {
          const { sql, snapshot, read } = yield* taxi;
          const [row] = yield* read(
            Schema.toCodecStringTree(DatasetMetadata),
            sql`SELECT
      CAST(MIN(tpep_pickup_datetime) AS DATE)::STRING AS from,
      CAST(MAX(tpep_pickup_datetime) AS DATE)::STRING AS to,
      CAST(COUNT(*) AS DOUBLE) AS trips FROM ${snapshot}`,
          );
          return row ?? (yield* taxiQueryUnavailable());
        }),
      {
        capacity: 1,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
      },
    );
    const metadata = Cache.get(metadataCache, "dataset");
    const overviewCache = yield* Cache.makeWith(
      (filters: Filters) =>
        Effect.gen(function* () {
          const { sql, snapshot, read } = yield* taxi;
          const predicate = tripWhere(sql, filters);
          return yield* Effect.all(
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
            Effect.flatMap((data) =>
              Effect.map(DateTime.now, (now) => ({
                ...data,
                queriedAt: DateTime.formatIso(now),
              })),
            ),
            Effect.withSpan("analytics.overview"),
          );
        }),
      {
        capacity: 64,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "60 seconds" : 0),
      },
    );
    return {
      metadata,
      overview: (filters: Filters) => Cache.get(overviewCache, filters),
    };
  });
