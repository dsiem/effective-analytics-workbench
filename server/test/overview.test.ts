import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { TestClock } from "effect/testing";
import { Overview } from "@dsiem/analytics-shared/overview";
import { AnalysisRuns } from "../src/analysis-runs.js";
import { Analytics } from "../src/taxi/analytics.js";
import { Genie } from "../src/genie/service.js";
import { Lakebase } from "../src/lakebase.js";
import { Routes } from "../src/routes.js";
import { SavedViews } from "../src/saved-views.js";
import { Settings } from "../src/settings.js";
import { TripComments } from "../src/trip-comments.js";
import { Warehouse } from "../src/warehouse.js";
import { Workspace } from "../src/workspace.js";
import { warehouseFetch } from "./warehouse-fixture.js";

const analyticsApp = () => {
  const services = Layer.mergeAll(
    Analytics.layer,
    AnalysisRuns.layer,
    Genie.layer,
    SavedViews.layer,
    TripComments.layer,
  ).pipe(
    Layer.provideMerge(Lakebase.layer),
    Layer.provideMerge(Warehouse.layer),
    Layer.provideMerge(Workspace.layer),
    Layer.provideMerge(Settings.layer),
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          DATABRICKS_HOST: "https://workspace.invalid",
          DATABRICKS_TOKEN: "fixture",
          GENIE_SPACE_ID: "fixture-space",
          DATABRICKS_WAREHOUSE_ID: "warehouse",
          TRIP_SNAPSHOT_TABLE: "catalog.schema.trips",
        }),
      ),
    ),
  );
  return HttpRouter.toWebHandler(
    Routes.pipe(
      Layer.provide(services),
      Layer.provideMerge(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
};

test("the overview API returns numeric aggregates and preserves ZIP strings from inline warehouse rows", async (t) => {
  const summary = {
    trips: 4,
    revenue: 70,
    avg_fare: 17.5,
    avg_distance: 2.5,
    avg_duration: 10,
  };
  const daily = [
    { day: "2016-01-01", trips: 2, revenue: 30 },
    { day: "2016-01-02", trips: 2, revenue: 40 },
  ];
  const hourly = [
    { hour: 9, trips: 2, avg_fare: 12.5 },
    { hour: 10, trips: 2, avg_fare: 22.5 },
  ];
  const zones = [{ zip: "01234", trips: 4, revenue: 70, avg_fare: 17.5 }];
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`
    CREATE DOMAIN STRING AS text;
    CREATE DOMAIN DOUBLE AS float8;
    CREATE TABLE trips AS SELECT pickup AS tpep_pickup_datetime,
      pickup + INTERVAL '10 minutes' AS tpep_dropoff_datetime,
      pickup_zip, fare_amount, trip_distance
    FROM (VALUES
      (timestamp '2016-01-01 09:00', '01234', 10, 1),
      (timestamp '2016-01-01 10:00', '01234', 20, 2),
      (timestamp '2016-01-02 09:00', '01234', 15, 3),
      (timestamp '2016-01-02 10:00', '01234', 25, 4),
      (timestamp '2015-12-31 23:59', '01234', 99, 5),
      (timestamp '2016-01-03 00:00', '01234', 99, 5),
      (timestamp '2016-01-01 09:00', '98765', 99, 5)
    ) AS source(pickup, pickup_zip, fare_amount, trip_distance)
  `);
  t.mock.method(
    globalThis,
    "fetch",
    warehouseFetch(async (statement, _, bindings) => {
      const query = statement
        .replaceAll("`", '"')
        .replace('"catalog"."schema"."trips"', "trips")
        .replace(/:p(\d+)/g, (_marker, index: string) => "$" + index)
        .replaceAll("INTERVAL 1 DAY", "INTERVAL '1 day'")
        .replace(
          "HOUR(tpep_pickup_datetime)",
          "EXTRACT(HOUR FROM tpep_pickup_datetime)",
        )
        .replace(
          "timestampdiff(SECOND, tpep_pickup_datetime, tpep_dropoff_datetime)",
          "EXTRACT(EPOCH FROM tpep_dropoff_datetime - tpep_pickup_datetime)",
        );
      return (
        await db.query<Record<string, number | string | null>>(
          query,
          bindings.map(({ value }) => value),
        )
      ).rows;
    }),
  );
  const app = analyticsApp();
  t.after(app.dispose);
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const load = Effect.promise(async () => {
        const response = await app.handler(
          new Request(
            "http://localhost/api/overview?from=2016-01-01&to=2016-01-02&zip=01234",
          ),
          context,
        );
        assert.equal(response.status, 200);
        return Schema.decodeUnknownSync(Overview)(await response.json());
      });

      const start = "2026-01-01T00:00:00.000Z";
      yield* TestClock.setTime(Date.parse(start));
      const first = yield* load;
      assert.deepEqual(first, {
        summary,
        daily,
        hourly,
        zones,
        queriedAt: start,
      });

      yield* TestClock.adjust("59 seconds");
      assert.deepEqual(yield* load, first);

      yield* TestClock.adjust("2 seconds");
      assert.equal((yield* load).queriedAt, "2026-01-01T00:01:01.000Z");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("a warehouse statement deadline returns the existing timeout response", async (t) => {
  const respond: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/api/2.0/sql/statements");
    return Response.json({
      statement_id: "timed-out-statement",
      status: {
        state: "FAILED",
        error: { error_code: "DEADLINE_EXCEEDED" },
      },
    });
  };
  const fetch = t.mock.method(globalThis, "fetch", respond);
  const app = analyticsApp();
  t.after(app.dispose);
  const response = await app.handler(
    new Request("http://localhost/api/metadata"),
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: {
      code: "warehouse_timeout",
      message: "The warehouse query timed out. Try again.",
    },
  });
  assert.equal(fetch.mock.callCount(), 1);
});
