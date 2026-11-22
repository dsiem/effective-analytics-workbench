import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { tableFromArrays } from "apache-arrow";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import type { TripCursor, TripSearch } from "../../shared/trips.js";
import { Analytics } from "../src/analytics.js";
import { Settings } from "../src/settings.js";
import { Workspace } from "../src/workspace.js";
import { warehouseFetch } from "./warehouse-fixture.js";

const details = {
  source_file: "yellow_tripdata_2016-01.csv.gz",
  vendor_id: 2,
  passenger_count: 1,
  rate_code_id: 1,
  store_and_fwd_flag: "N",
  payment_type: 2,
  pickup_location: { longitude: -73.99, latitude: 40.75 },
  dropoff_location: null,
  tip_amount: 0,
  tolls_amount: 0,
  extra: 0.5,
  mta_tax: 0.5,
  improvement_surcharge: 0.3,
  total_amount: 11.3,
};

function readTrips(search: TripSearch) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      return yield* analytics.trips(search);
    }).pipe(
      Effect.provide(
        Analytics.layer.pipe(
          Layer.provide(
            Layer.succeed(Workspace, {
              requestEvents: () =>
                Effect.die("Unexpected workspace event request"),
              accessToken: Effect.succeed(Redacted.make("test")),
              request: () => Effect.die("Unexpected workspace request"),
            }),
          ),
          Layer.provide(Settings.layer),
        ),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          DATABRICKS_HOST: "https://workspace.invalid",
          DATABRICKS_WAREHOUSE_ID: "warehouse",
          TRIP_SNAPSHOT_TABLE: "custom.taxi.trips",
        }),
      ),
      Effect.scoped,
    ),
  );
}

test("warehouse trips decode actual GPS, zero tips and missing endpoints into API details", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    warehouseFetch(async (statement) =>
      statement.includes("AS total FROM")
        ? tableFromArrays({ total: [1] })
        : tableFromArrays({
            trip_id: ["trip-1"],
            pickup_at: ["2016-01-01 10:00:00"],
            dropoff_at: ["2016-01-01 10:10:00"],
            pickup_zip: ["10001"],
            dropoff_zip: ["Unknown"],
            fare: [10],
            distance: [2],
            duration: [10],
            details: [JSON.stringify(details)],
          }),
    ),
  );
  const result = await readTrips({});
  assert.equal(result.nextCursor, null);
  assert.equal(result.total, 1);
  assert.equal(result.rows[0]?.dropoff_zip, "Unknown");
  assert.deepEqual(result.rows[0]?.details, details);
});

test("trip pages preserve the warehouse order across ties, nulls, deleted anchors and deep positions", async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`
    CREATE DOMAIN TIMESTAMP_NTZ AS timestamp(6);
    CREATE DOMAIN STRING AS text;
    CREATE DOMAIN DOUBLE AS float8;
    CREATE TABLE trips AS
      SELECT lpad(i::text, 6, '0') AS trip_id,
        timestamp '2016-01-01 09:00:00.000001' + (i % 2) * interval '1 microsecond' AS tpep_pickup_datetime,
        timestamp '2016-01-01 09:10:00.123456' + (i % 3) * interval '1 microsecond' AS tpep_dropoff_datetime,
        CASE (i % 4) WHEN 0 THEN NULL WHEN 1 THEN '10001' ELSE '10002' END AS pickup_zip,
        CASE (i % 3) WHEN 0 THEN NULL WHEN 1 THEN 'Unknown' ELSE '10003' END AS dropoff_zip,
        CASE (i % 3) WHEN 0 THEN NULL WHEN 1 THEN 42.00000000000001::float8 ELSE 42::float8 END AS fare_amount,
        CASE (i % 4) WHEN 0 THEN NULL WHEN 1 THEN 0.12345678912345::float8 ELSE 12::float8 END AS trip_distance
      FROM generate_series(1,100) i`);

  // Run the emitted SQL with Postgres equivalents for Spark-only expressions.
  t.mock.method(
    globalThis,
    "fetch",
    warehouseFetch(async (statement, _, parameters) => {
      const values = parameters.map((param) => param.value);
      const query = statement
        .replaceAll("`", '"')
        .replaceAll('"custom"."taxi"."trips"', "trips")
        .replace(/:p(\d+)/g, (_marker, index: string) => "$" + index)
        .replace(
          "timestampdiff(SECOND,tpep_pickup_datetime,tpep_dropoff_datetime)",
          "EXTRACT(EPOCH FROM tpep_dropoff_datetime - tpep_pickup_datetime)",
        )
        .replace(
          /to_json\(named_struct\([\s\S]+? AS details/,
          () => `$${values.push(JSON.stringify(details))}::text AS details`,
        );
      const { rows, fields } = await db.query<
        Record<string, string | number | null>
      >(query, values);
      return tableFromArrays(
        Object.fromEntries(
          fields.map(({ name }) => [name, rows.map((row) => row[name])]),
        ),
      );
    }),
  );
  const primary = {
    newest: "tpep_pickup_datetime",
    fare: "fare_amount",
    distance: "trip_distance",
  };
  for (const sort of ["newest", "fare", "distance"] as const) {
    await t.test(`${sort} pages match the full original order`, async () => {
      const { rows: expected } = await db.query<{ trip_id: string }>(
        `SELECT trip_id, coalesce(pickup_zip, 'Unknown') AS pickup_zip,
       coalesce(dropoff_zip, 'Unknown') AS dropoff_zip FROM trips ORDER BY ${primary[sort]} DESC NULLS LAST,
       tpep_pickup_datetime DESC, tpep_dropoff_datetime DESC, pickup_zip NULLS FIRST,
       dropoff_zip NULLS FIRST, fare_amount NULLS FIRST, trip_distance NULLS FIRST, trip_id`,
      );
      let cursor: TripCursor | null = null;
      for (let page = 0; page < 4; page++) {
        const result = await readTrips(cursor ? { sort, cursor } : { sort });
        assert.equal(result.total, 100);
        assert.equal(result.pageSize, 25);
        assert.deepEqual(
          result.rows.map((row) => row.trip_id),
          expected.slice(page * 25, (page + 1) * 25).map((row) => row.trip_id),
        );
        cursor = result.nextCursor;
        assert.equal(cursor !== null, page < 3);
      }
    });
  }
  await t.test(
    "empty and exactly full pages have no continuation",
    async () => {
      const filtered = await readTrips({ zip: "10001" });
      assert.equal(filtered.total, 25);
      assert.equal(filtered.rows.length, 25);
      assert.equal(filtered.nextCursor, null);
      const empty = await readTrips({ zip: "99999" });
      assert.deepEqual(empty, {
        rows: [],
        total: 0,
        pageSize: 25,
        nextCursor: null,
      });
    },
  );
  await t.test("deleting the cursor row preserves the next page", async () => {
    const first = await readTrips({ zip: "10002" });
    assert.ok(first.nextCursor);
    const next = await readTrips({ zip: "10002", cursor: first.nextCursor });
    await db.query("DELETE FROM trips WHERE trip_id = $1", [
      first.nextCursor.after.trip_id,
    ]);
    const afterDelete = await readTrips({
      zip: "10002",
      cursor: first.nextCursor,
    });
    assert.equal(afterDelete.total, 49);
    assert.deepEqual(afterDelete.rows, next.rows);
  });
  await t.test(
    "a cursor after 250,000 tied trips reaches the final row",
    async () => {
      await db.exec(`TRUNCATE trips;
    INSERT INTO trips SELECT lpad(i::text, 6, '0'), timestamp '2016-01-01 10:00',
      timestamp '2016-01-01 10:10', NULL, NULL, NULL, NULL FROM generate_series(1,250026) i`);
      const deep = await readTrips({
        cursor: {
          sort: "newest",
          filters: {},
          after: {
            trip_id: "250000",
            pickup_at: "2016-01-01 10:00:00",
            dropoff_at: "2016-01-01 10:10:00",
            pickup_zip: "Unknown",
            dropoff_zip: "Unknown",
            fare: null,
            distance: null,
          },
        },
      });
      assert.equal(deep.total, 250026);
      assert.deepEqual(
        deep.rows.map((row) => row.trip_id),
        Array.from({ length: 25 }, (_, i) => String(250001 + i)),
      );
      assert.ok(deep.nextCursor);
      const final = await readTrips({ cursor: deep.nextCursor });
      assert.deepEqual(
        final.rows.map((row) => row.trip_id),
        ["250026"],
      );
      assert.equal(final.nextCursor, null);
    },
  );
});
