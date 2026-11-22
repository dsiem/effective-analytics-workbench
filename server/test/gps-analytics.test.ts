import assert from "node:assert/strict";
import { test } from "node:test";
import { tableFromArrays } from "apache-arrow";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { gpsFixture } from "../../client/test/gps-fixture.js";
import { mapCellLimit } from "../../shared/map-dataset.js";
import { Analytics } from "../src/analytics.js";
import { Settings } from "../src/settings.js";
import { Workspace } from "../src/workspace.js";
import { warehouseFetch } from "./warehouse-fixture.js";

const services = Analytics.layer.pipe(
  Layer.provide(Settings.layer),
  Layer.provide(
    Layer.succeed(Workspace, {
      requestEvents: () => Effect.die("Unexpected workspace event request"),
      accessToken: Effect.succeed(Redacted.make("unused")),
      request: () => Effect.die("Unexpected workspace request"),
    }),
  ),
);
const provide = Effect.provideService(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromEnvRecord({
    DATABRICKS_HOST: "https://workspace.invalid",
    DATABRICKS_WAREHOUSE_ID: "warehouse",
    TRIP_SNAPSHOT_TABLE: "test.taxi.trips",
  }),
);
for (const truncated of [false, true])
  test(`GPS aggregates ${truncated ? "report a bounded partial result honestly" : "decode geometry, reconcile counts and share concurrent lookups"}`, async (t) => {
    const original = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    const fixture = gpsFixture();
    const cell = fixture.cells[0];
    assert.ok(cell);
    const rows = truncated
      ? Array.from({ length: mapCellLimit }, (_, index) => ({
          ...cell,
          id: `cell-${index}`,
          trips: 1,
        }))
      : fixture.cells;
    const totalCells = truncated ? mapCellLimit + 1 : fixture.totalCells;
    const located = truncated ? totalCells : fixture.locatedTrips;
    let statements = 0;
    globalThis.fetch = warehouseFetch(async (statement, _, parameters) => {
      statements++;
      if (!statement.includes("WITH bins"))
        return [{ matching: located + 20, located }];
      assert.deepEqual(parameters, [
        { name: "p1", type: "INT", value: String(mapCellLimit) },
      ]);
      return tableFromArrays({
        id: rows.map((x) => x.id),
        longitude: rows.map((x) => x.longitude),
        latitude: rows.map((x) => x.latitude),
        trips: rows.map((x) => x.trips),
        avg_fare: rows.map((x) => x.avg_fare),
        avg_distance: rows.map((x) => x.avg_distance),
        zip: rows.map((x) => x.zip),
        boundary: rows.map((x) => JSON.stringify(x.boundary)),
        total_cells: rows.map(() => totalCells),
      });
    });
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* Analytics;
        return yield* Effect.all(
          [
            analytics.tripMap({ endpoint: "dropoff" }),
            analytics.tripMap({ endpoint: "dropoff" }),
          ],
          { concurrency: 2 },
        );
      }).pipe(Effect.provide(services), provide, Effect.scoped),
    );
    assert.deepEqual(first, second);
    assert.equal(statements, 2);
    assert.equal(first.endpoint, "dropoff");
    assert.equal(first.locatedTrips, located);
    assert.equal(first.truncated, truncated);
    assert.equal(first.shownTrips, truncated ? mapCellLimit : 80);
    assert.equal(first.cells.length, rows.length);
    assert.equal(first.totalCells, totalCells);
    assert.deepEqual(first.cells[0]?.boundary, cell.boundary);
    const firstCell = first.cells[0];
    assert.ok(firstCell);
    assert.equal(Reflect.has(firstCell, "total_cells"), false);
  });

test("trip map distinguishes warehouse access denials from authentication failures", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let status = 403;
  globalThis.fetch = async () => new Response("private diagnostic", { status });
  await Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      const map = analytics.tripMap({ endpoint: "pickup" });
      const denied = yield* Effect.result(map);
      assert.ok(
        denied._tag === "Failure" && denied.failure._tag === "PermissionDenied",
      );
      assert.match(denied.failure.message, /trip data/);
      status = 401;
      const unauthenticated = yield* Effect.result(map);
      assert.ok(
        unauthenticated._tag === "Failure" &&
          unauthenticated.failure._tag === "ServiceUnavailable",
      );
    }).pipe(Effect.provide(services), provide, Effect.scoped),
  );
});
