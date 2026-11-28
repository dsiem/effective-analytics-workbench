import { Cache, DateTime, Effect, Exit, Schema } from "effect";
import { DatasetMetadata } from "@dsiem/analytics-shared/dataset";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { Daily, Hourly, Summary, Zone } from "@dsiem/analytics-shared/overview";
import { taxiQueryUnavailable, type TaxiSnapshot } from "./snapshot.js";

export const makeOverview = (taxi: TaxiSnapshot) =>
  Effect.gen(function* () {
    const metadataCache = yield* Cache.makeWith(
      (_key: "dataset") =>
        Effect.gen(function* () {
          const { sql, source, read } = yield* taxi;
          const [row] = yield* read(
            Schema.toCodecStringTree(DatasetMetadata),
            source.aggregate({
              filters: {},
              measures: {
                from: sql`CAST(MIN(tpep_pickup_datetime) AS DATE)::STRING`,
                to: sql`CAST(MAX(tpep_pickup_datetime) AS DATE)::STRING`,
                trips: sql`CAST(COUNT(*) AS DOUBLE)`,
              },
            }),
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
          const { sql, source, read } = yield* taxi;
          const trips = sql`CAST(COUNT(*) AS DOUBLE)`;
          const revenue = sql`CAST(COALESCE(SUM(fare_amount), 0) AS DOUBLE)`;
          const avg_fare = sql`CAST(COALESCE(AVG(fare_amount), 0) AS DOUBLE)`;
          return yield* Effect.all(
            {
              summary: read(
                Schema.toCodecStringTree(Summary),
                source.aggregate({
                  filters,
                  measures: {
                    trips,
                    revenue,
                    avg_fare,
                    avg_distance: sql`CAST(COALESCE(AVG(trip_distance), 0) AS DOUBLE)`,
                    avg_duration: sql`CAST(COALESCE(AVG(timestampdiff(SECOND, tpep_pickup_datetime, tpep_dropoff_datetime) / 60.0), 0) AS DOUBLE)`,
                  },
                }),
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
                source.aggregate({
                  filters,
                  dimensions: {
                    day: sql`CAST(CAST(tpep_pickup_datetime AS DATE) AS STRING)`,
                  },
                  measures: { trips, revenue },
                  orderBy: [sql`day`],
                }),
              ),
              hourly: read(
                Schema.toCodecStringTree(Hourly),
                source.aggregate({
                  filters,
                  dimensions: {
                    hour: sql`CAST(HOUR(tpep_pickup_datetime) AS DOUBLE)`,
                  },
                  measures: { trips, avg_fare },
                  orderBy: [sql`hour`],
                }),
              ),
              zones: read(
                Schema.toCodecStringTree(Zone),
                source.aggregate({
                  filters,
                  dimensions: {
                    zip: sql`COALESCE(CAST(pickup_zip AS STRING), 'Unknown')`,
                  },
                  measures: { trips, revenue, avg_fare },
                  orderBy: [sql`trips DESC`],
                }),
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
