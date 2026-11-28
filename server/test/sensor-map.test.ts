import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Redacted, Schema } from "effect";
import { dataset } from "@dsiem/analytics";
import { h3Cells } from "@dsiem/analytics/spark";
import { DatabricksClient } from "@dsiem/sql-warehouse";
import { gpsFixture } from "../../client/test/gps-fixture.js";
import { warehouseFetch } from "./warehouse-fixture.js";

test("temperature maps rank calibrated sensor cells and count all groups before limiting", async (t) => {
  const [cooler, hotter] = gpsFixture().cells;
  assert.ok(cooler && hotter);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE readings(lon REAL, lat REAL, temperature REAL, station TEXT, calibrated INT)",
  );
  const insert = db.prepare("INSERT INTO readings VALUES(?, ?, ?, ?, ?)");
  for (const [cell, temperature, station, calibrated] of [
    [cooler, 5, "park", 1],
    [cooler, 15, "park", 1],
    [hotter, 12, "park", 1],
    [hotter, 16, "park", 1],
    [cooler, 95, "park", 0],
    [cooler, 99, "roof", 1],
  ] as const)
    insert.run(cell.longitude, cell.latitude, temperature, station, calibrated);

  // SQLite runs the selection, aggregates, window and ordering. These four
  // scalar functions provide the warehouse H3 values for known coordinates.
  const cells = [cooler, hotter];
  db.function("h3_longlatash3", (lon, lat, resolution) => {
    assert.equal(resolution, 10);
    const cell = cells.find((c) => c.longitude === lon && c.latitude === lat);
    assert.ok(cell);
    return cell.id;
  });
  db.function("h3_h3tostring", (id) => String(id));
  db.function("h3_centerasgeojson", (id) => {
    const cell = cells.find((c) => c.id === id);
    assert.ok(cell);
    return JSON.stringify({
      type: "Point",
      coordinates: [cell.longitude, cell.latitude],
    });
  });
  db.function("h3_boundaryasgeojson", (id) => {
    const cell = cells.find((c) => c.id === id);
    assert.ok(cell);
    return JSON.stringify(cell.boundary);
  });
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Number, Schema.Null]),
      ),
    ),
  );
  const fetch = warehouseFetch(async (statement, _, bindings) => {
    const query = statement
      .replaceAll("::DOUBLE", "")
      .replace(/:coordinates\[(\d)\]/g, " ->> '$.coordinates[$1]'")
      .replace(/:p\d+/g, "?");
    const params = bindings.map(({ type, value }) =>
      type === "INT" ? Number(value) : value,
    );
    return rows(db.prepare(query).all(...params));
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const readings = dataset(sql, {
        table: sql("readings"),
        predicates: (station: string) => [sql`station = ${station}`],
      });
      return yield* h3Cells(sql, readings, {
        filters: "park",
        where: sql`calibrated = 1`,
        longitude: sql("lon"),
        latitude: sql("lat"),
        resolution: 10,
        measures: { mean_celsius: sql`AVG(temperature)` },
        rankBy: { measure: "mean_celsius", direction: "desc" },
        limit: 1,
      });
    }).pipe(
      Effect.provide(
        DatabricksClient.layer({
          host: "https://workspace.invalid",
          warehouseId: "fixture",
          accessToken: Effect.succeed(Redacted.make("fixture")),
          fetch,
        }),
      ),
    ),
  );
  assert.deepEqual(result, [
    {
      id: hotter.id,
      longitude: String(hotter.longitude),
      latitude: String(hotter.latitude),
      boundary: JSON.stringify(hotter.boundary),
      mean_celsius: "14",
      total_cells: "2",
    },
  ]);
});
