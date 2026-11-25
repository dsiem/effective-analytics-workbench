import assert from "node:assert/strict";
import { test } from "node:test";
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

test("the overview API returns numeric aggregates and preserves ZIP strings from inline warehouse rows", async (t) => {
  const summary = {
    trips: 4,
    revenue: 70,
    avg_fare: 17.5,
    avg_distance: 2.5,
    avg_duration: 10,
  };
  const daily = [{ day: "2016-01-01", trips: 4, revenue: 70 }];
  const hourly = [{ hour: 9, trips: 4, avg_fare: 17.5 }];
  const zones = [{ zip: "01234", trips: 4, revenue: 70, avg_fare: 17.5 }];
  t.mock.method(
    globalThis,
    "fetch",
    warehouseFetch(async (sql) => {
      if (sql.includes(" AS avg_duration")) return [summary];
      if (sql.includes(" AS day,")) return daily;
      if (sql.includes(" AS hour,")) return hourly;
      assert.match(sql, / AS zip,/);
      return zones;
    }),
  );
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
  const app = HttpRouter.toWebHandler(
    Routes.pipe(
      Layer.provide(services),
      Layer.provideMerge(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  t.after(app.dispose);
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const load = Effect.promise(async () => {
        const response = await app.handler(
          new Request("http://localhost/api/overview"),
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
