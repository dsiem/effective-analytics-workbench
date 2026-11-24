import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Redacted,
  Schema,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  defaultTripLimit,
  TripPage,
  type TripSearch,
} from "../../shared/trips.js";
import { Analytics } from "../src/analytics.js";
import {
  InvalidRequest,
  ServiceUnavailable,
  TripNotFound,
} from "../src/errors.js";
import { Settings } from "../src/settings.js";
import { makeTripPages } from "../src/taxi/trip-pages.js";
import { Warehouse } from "../src/warehouse.js";
import { Workspace } from "../src/workspace.js";
import { inlineResult, warehouseFetch } from "./warehouse-fixture.js";

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

function tripRow(trip_id: string) {
  return {
    trip_id,
    pickup_at: "2016-01-01 10:00:00",
    dropoff_at: "2016-01-01 10:10:00",
    pickup_zip: "10001",
    dropoff_zip: "Unknown",
    fare: 10,
    distance: 2,
    duration: 10,
  };
}

test("a trip chunk that fails encoding leaves its successor unavailable", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const pages = yield* makeTripPages(() =>
        Effect.succeed({
          pageCount: 3,
          rows: [tripRow("first")],
          truncated: false,
          readChunk: (index) =>
            Effect.succeed([tripRow(index === 1 ? "" : "third")]),
        }),
      );
      const first = Schema.decodeUnknownSync(Schema.fromJsonString(TripPage))(
        new TextDecoder().decode(yield* pages.trips({})),
      );
      assert.ok(first.nextCursor);
      const rejected = yield* Effect.exit(pages.tripPage(first.nextCursor));
      assert.ok(Exit.isFailure(rejected) && Cause.hasDies(rejected.cause));
      const successor = first.nextCursor.replace(/\.1$/, ".2");
      const result = yield* Effect.result(pages.tripPage(successor));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal(result.failure._tag, "InvalidRequest");
    }),
  );
});

function runTrips<A, E>(program: Effect.Effect<A, E, Analytics>) {
  return Effect.runPromise(
    program.pipe(
      Effect.provide(
        Analytics.layer.pipe(
          Layer.provide(Warehouse.layer),
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

const decodePage = (body: Uint8Array) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(TripPage))(
    new TextDecoder().decode(body),
  );

function collectTrips(search: TripSearch) {
  return Effect.gen(function* () {
    const analytics = yield* Analytics;
    const first = decodePage(yield* analytics.trips(search));
    const rows = [...first.rows];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = decodePage(yield* analytics.tripPage(cursor));
      rows.push(...next.rows);
      cursor = next.nextCursor;
    }
    return { rows, hasMore: first.hasMoreMatches };
  });
}

test("warehouse trip pages decode named rows and omit inspector details", async (t) => {
  const statements: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    warehouseFetch(async (statement) => {
      statements.push(statement);
      return [
        {
          fare: null,
          duration: "15",
          trip_id: "00007",
          pickup_zip: "01001",
          distance: "3.25",
          pickup_at: "2016-01-01 10:00:00",
          dropoff_at: "2016-01-01 10:15:00",
          dropoff_zip: "00019",
        },
      ];
    }),
  );
  const result = await runTrips(collectTrips({}));
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.rows, [
    {
      trip_id: "00007",
      pickup_at: "2016-01-01 10:00:00",
      dropoff_at: "2016-01-01 10:15:00",
      pickup_zip: "01001",
      dropoff_zip: "00019",
      distance: 3.25,
      fare: 0,
      duration: 15,
    },
  ]);
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0] ?? "", /AS details\b/i);
  assert.equal(Object.hasOwn(result.rows[0] ?? {}, "details"), false);
});

test("trip pages return typed rows on demand and share concurrent reads until expiry", async (t) => {
  const first = inlineResult([tripRow("first")]);
  const statement = JSON.stringify({
    statement_id: "upstream-only",
    status: { state: "SUCCEEDED" },
    manifest: {
      ...first.manifest,
      total_chunk_count: 2,
      total_row_count: 2,
      truncated: true,
    },
    result: { ...first.result, next_chunk_index: 1 },
  });
  const tail = JSON.stringify({
    ...inlineResult([tripRow("second")]).result,
    chunk_index: 1,
    row_offset: 1,
  });
  let starts = 0;
  let reads = 0;
  let denyPage = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        starts++;
        assert.equal(
          request.url,
          "https://workspace.invalid/api/2.0/sql/statements",
        );
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            row_limit: Schema.Number,
            parameters: Schema.Array(Schema.Struct({ value: Schema.String })),
          }),
        )(await request.json());
        assert.equal(body.row_limit, 2);
        assert.equal(body.parameters.at(-1)?.value, "3");
        return new Response(statement, {
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(
        request.url,
        "https://workspace.invalid/api/2.0/sql/statements/upstream-only/result/chunks/1",
      );
      reads++;
      return new Response(tail, {
        status: denyPage ? 403 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  await runTrips(
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      const request = analytics.trips({ limit: 2 });
      const [a, b] = yield* Effect.all([request, request], { concurrency: 2 });
      const page = decodePage(a);
      assert.deepEqual(page.rows, [tripRow("first")]);
      assert.equal(page.hasMoreMatches, true);
      assert.equal(starts, 1);
      assert.equal(reads, 0);
      const cursor = page.nextCursor;
      assert.ok(cursor);
      assert.deepEqual(a, b);
      assert.ok(!cursor.includes("upstream-only"));
      for (const invalid of ["upstream-only.1", cursor.replace(/\.1$/, ".2")]) {
        assert.ok(
          (yield* Effect.flip(analytics.tripPage(invalid))) instanceof
            InvalidRequest,
        );
      }
      const next = analytics.tripPage(cursor);
      const [one, two] = yield* Effect.all([next, next], { concurrency: 2 });
      assert.deepEqual(decodePage(one), {
        rows: [tripRow("second")],
        nextCursor: null,
        hasMoreMatches: true,
      });
      assert.deepEqual(two, one);
      assert.deepEqual(yield* next, one);
      assert.equal(reads, 1);
      yield* TestClock.adjust("61 seconds");
      denyPage = true;
      const replacement = decodePage(yield* request);
      assert.equal(starts, 2);
      assert.ok(replacement.nextCursor);
      const failure = yield* Effect.flip(
        analytics.tripPage(replacement.nextCursor),
      );
      assert.equal(failure._tag, "PermissionDenied");
      denyPage = false;
      const fresh = decodePage(yield* request);
      assert.equal(starts, 3);
      assert.notEqual(fresh.nextCursor, replacement.nextCursor);
      yield* TestClock.adjust("16 minutes");
      assert.ok((yield* Effect.flip(next)) instanceof InvalidRequest);
      assert.equal(reads, 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("trip continuations reject invalid offsets, row counts, and widths after cache expiry", async (t) => {
  const first = inlineResult([tripRow("first")]);
  const tail = {
    ...inlineResult([tripRow("second")]).result,
    chunk_index: 1,
    row_offset: 1,
  };
  let chunk = tail;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      return Response.json(
        request.method === "POST"
          ? {
              statement_id: "trip-pages",
              status: { state: "SUCCEEDED" },
              manifest: {
                ...first.manifest,
                total_chunk_count: 2,
                total_row_count: 2,
              },
              result: { ...first.result, next_chunk_index: 1 },
            }
          : chunk,
      );
    },
  );
  await runTrips(
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      const { nextCursor } = decodePage(yield* analytics.trips({}));
      assert.ok(nextCursor);
      yield* TestClock.adjust("61 seconds");
      for (const invalid of [
        { ...tail, row_offset: 99 },
        { ...tail, row_count: 0, data_array: [] },
        { ...tail, data_array: [["second"]] },
        { ...tail, next_chunk_index: 2 },
      ]) {
        chunk = invalid;
        assert.equal(
          (yield* Effect.flip(analytics.tripPage(nextCursor)))._tag,
          "ServiceUnavailable",
        );
      }
      chunk = tail;
      assert.deepEqual(decodePage(yield* analytics.tripPage(nextCursor)), {
        rows: [tripRow("second")],
        nextCursor: null,
        hasMoreMatches: false,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("trip continuations check cumulative counts when Databricks omits offsets", async (t) => {
  const first = inlineResult([tripRow("first")]);
  const second = inlineResult([tripRow("second")]);
  const last = inlineResult([tripRow("last")]);
  let terminal = { data_array: [] as readonly (readonly (string | null)[])[] };
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      if (path.endsWith("/1"))
        return Response.json({ data_array: second.result.data_array });
      if (path.endsWith("/2")) return Response.json(terminal);
      return Response.json({
        statement_id: "trip-pages",
        status: { state: "SUCCEEDED" },
        manifest: {
          ...first.manifest,
          total_chunk_count: 3,
          total_row_count: 3,
        },
        result: first.result,
      });
    },
  );
  await runTrips(
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      const { nextCursor: secondCursor } = decodePage(
        yield* analytics.trips({}),
      );
      assert.ok(secondCursor);
      const skipCursor = secondCursor.replace(/\.1$/, ".2");
      assert.ok(
        (yield* Effect.flip(analytics.tripPage(skipCursor))) instanceof
          InvalidRequest,
      );
      yield* TestClock.adjust("61 seconds");
      const secondPage = analytics.tripPage(secondCursor);
      const { nextCursor: lastCursor } = decodePage(yield* secondPage);
      assert.ok(lastCursor);
      assert.equal(decodePage(yield* secondPage).nextCursor, lastCursor);
      assert.equal(
        (yield* Effect.flip(analytics.tripPage(lastCursor)))._tag,
        "ServiceUnavailable",
      );
      terminal = { data_array: last.result.data_array };
      assert.deepEqual(decodePage(yield* analytics.tripPage(lastCursor)), {
        rows: [tripRow("last")],
        nextCursor: null,
        hasMoreMatches: false,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("warehouse trip details load by ID, preserve enrichment and reject invalid rows", async (t) => {
  const statements: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    warehouseFetch(async (statement, _, parameters) => {
      statements.push(statement);
      const id = parameters[0]?.value;
      assert.match(statement, /WHERE trip_id = :p1 LIMIT 1$/);
      assert.equal(parameters[0]?.type, "STRING");
      if (id !== "trip-1" && id !== "invalid-duration") return [];
      return [
        {
          ...tripRow(id),
          fare: null,
          duration: id === "invalid-duration" ? "Infinity" : 10,
          details: JSON.stringify(details),
        },
      ];
    }),
  );
  const get = (id: string) =>
    runTrips(
      Effect.flatMap(Analytics, (analytics) => analytics.tripDetails(id)),
    );
  assert.deepEqual(await get("trip-1"), {
    trip_id: "trip-1",
    pickup_at: "2016-01-01 10:00:00",
    dropoff_at: "2016-01-01 10:10:00",
    pickup_zip: "10001",
    dropoff_zip: "Unknown",
    fare: 0,
    distance: 2,
    duration: 10,
    details,
  });
  assert.match(statements[0] ?? "", /AS details\b/i);
  await assert.rejects(get("missing-trip"), TripNotFound);
  await assert.rejects(get("invalid-duration"), ServiceUnavailable);
});

test("trip pages preserve warehouse order across ties and nulls", async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`
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
      FROM generate_series(1,${defaultTripLimit + 1}) i`);

  let queryCount = 0;
  let fetchLimit: string | null | undefined;
  // Run the emitted SQL with Postgres equivalents for Spark-only expressions.
  t.mock.method(
    globalThis,
    "fetch",
    warehouseFetch(async (statement, _, parameters) => {
      const limit = statement.match(/LIMIT :(p\d+)$/)?.[1];
      queryCount++;
      assert.doesNotMatch(statement, /COUNT\s*\(/i);
      fetchLimit = parameters.find(({ name }) => name === limit)?.value;
      const values = parameters.map((param) => param.value);
      const query = statement
        .replaceAll("`", '"')
        .replaceAll('"custom"."taxi"."trips"', "trips")
        .replace(/:p(\d+)/g, (_marker, index: string) => "$" + index)
        .replace(
          "timestampdiff(SECOND,tpep_pickup_datetime,tpep_dropoff_datetime)",
          "EXTRACT(EPOCH FROM tpep_dropoff_datetime - tpep_pickup_datetime)",
        );
      const { rows } = await db.query<Record<string, string | number | null>>(
        query,
        values,
      );
      return rows;
    }),
  );
  const primary = {
    newest: "tpep_pickup_datetime",
    fare: "fare_amount",
    distance: "trip_distance",
  };
  for (const sort of ["newest", "fare", "distance"] as const) {
    await t.test(
      `${sort} preview matches the first 10,000 rows in warehouse order`,
      async () => {
        const { rows: expected } = await db.query<{ trip_id: string }>(
          `SELECT trip_id, coalesce(pickup_zip, 'Unknown') AS pickup_zip,
       coalesce(dropoff_zip, 'Unknown') AS dropoff_zip FROM trips ORDER BY ${primary[sort]} DESC NULLS LAST,
       tpep_pickup_datetime DESC, tpep_dropoff_datetime DESC, pickup_zip NULLS FIRST,
       dropoff_zip NULLS FIRST, fare_amount NULLS FIRST, trip_distance NULLS FIRST, trip_id`,
        );
        const start = queryCount;
        const result = await runTrips(collectTrips({ sort }));
        assert.equal(queryCount, start + 1);
        assert.equal(fetchLimit, String(defaultTripLimit + 1));
        assert.equal(result.rows.length, defaultTripLimit);
        assert.equal(result.hasMore, true);
        assert.deepEqual(
          result.rows.map((row) => row.trip_id),
          expected.slice(0, defaultTripLimit).map((row) => row.trip_id),
        );
      },
    );
  }
  await t.test("filtered pages reuse results until expiry", async () => {
    const start = queryCount;
    await runTrips(
      Effect.gen(function* () {
        const filtered = yield* collectTrips({ zip: "10001" });
        assert.ok(filtered.rows.length > 0);
        assert.ok(filtered.rows.every((row) => row.pickup_zip === "10001"));
        assert.equal(filtered.hasMore, false);
        assert.deepEqual(yield* collectTrips({ zip: "10001" }), filtered);
        assert.equal(queryCount, start + 1);

        const limited = {
          rows: filtered.rows.slice(0, 3),
          hasMore: true,
        };
        assert.deepEqual(
          yield* collectTrips({ zip: "10001", limit: 3 }),
          limited,
        );
        assert.equal(fetchLimit, "4");
        assert.equal(queryCount, start + 2);
        assert.deepEqual(
          yield* collectTrips({ zip: "10001", limit: 3 }),
          limited,
        );
        assert.equal(queryCount, start + 2);

        yield* TestClock.adjust("61 seconds");
        assert.deepEqual(yield* collectTrips({ zip: "10001" }), filtered);
        assert.equal(queryCount, start + 3);
        assert.deepEqual(yield* collectTrips({ zip: "99999" }), {
          rows: [],
          hasMore: false,
        });
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
  await t.test("a requested limit can exceed the default", async () => {
    const limit = defaultTripLimit + 1;
    const result = await runTrips(collectTrips({ limit }));
    assert.equal(fetchLimit, String(limit + 1));
    assert.equal(result.rows.length, limit);
    assert.equal(result.hasMore, false);
  });
  await t.test(
    "10,000 matches fill the preview without setting hasMore",
    async () => {
      await db.query("DELETE FROM trips WHERE trip_id = $1", ["000001"]);
      const exact = await runTrips(collectTrips({}));
      assert.equal(exact.rows.length, defaultTripLimit);
      assert.equal(exact.hasMore, false);
    },
  );
});
