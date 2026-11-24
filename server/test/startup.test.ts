import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, ConfigProvider, Effect, Exit, Layer, Redacted } from "effect";
import { Analytics } from "../src/analytics.js";
import { unavailable } from "../src/errors.js";
import { Genie } from "../src/genie.js";
import { Lakebase } from "../src/lakebase.js";
import { SavedViews } from "../src/saved-views.js";
import { Settings } from "../src/settings.js";
import { TripComments } from "../src/trip-comments.js";
import { Warehouse } from "../src/warehouse.js";
import { Workspace } from "../src/workspace.js";
import { warehouseFetch } from "./warehouse-fixture.js";

const config = Layer.succeed(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromEnvRecord({
    DATABRICKS_HOST: "https://workspace.invalid",
    GENIE_SPACE_ID: "fixture-space",
    DATABRICKS_WAREHOUSE_ID: "warehouse",
    TRIP_SNAPSHOT_TABLE: "test.snapshot.trips",
    LAKEBASE_ENDPOINT: "projects/test/branches/main/endpoints/primary",
  }),
);

test("Lakebase discovery failures leave other services running and can be retried", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = warehouseFetch();
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let discoveries = 0;
  const diagnostic = new Error("Temporary discovery outage");
  const services = Layer.mergeAll(
    Analytics.layer.pipe(Layer.provide(Warehouse.layer)),
    Genie.layer,
    SavedViews.layer,
    TripComments.layer,
  ).pipe(
    Layer.provideMerge(Lakebase.layer),
    Layer.provide(
      Layer.succeed(Workspace, {
        requestEvents: () => Effect.die("Unexpected workspace event request"),
        accessToken: Effect.succeed(Redacted.make("unused")),
        request: () =>
          Effect.suspend(() => {
            discoveries++;
            return Effect.fail(
              unavailable("workspace", "Discovery unavailable", diagnostic),
            );
          }),
      }),
    ),
    Layer.provide(Settings.layer),
    Layer.provide(config),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      const savedViews = yield* SavedViews;
      assert.equal(
        discoveries,
        0,
        "constructing all services must not call Lakebase",
      );
      for (let attempt = 1; attempt <= 2; attempt++) {
        const exit = yield* Effect.exit(savedViews.list({}));
        assert.ok(Exit.isFailure(exit));
        const error = Cause.findErrorOption(exit.cause);
        assert.ok(
          error._tag === "Some" && error.value._tag === "ServiceUnavailable",
        );
        assert.equal(
          discoveries,
          attempt,
          "failed discovery must not poison initialization",
        );
        assert.deepEqual(yield* analytics.metadata, {
          from: "2016-01-01",
          to: "2016-12-31",
          trips: 10,
        });
      }
    }).pipe(Effect.provide(services), Effect.scoped),
  );
});
