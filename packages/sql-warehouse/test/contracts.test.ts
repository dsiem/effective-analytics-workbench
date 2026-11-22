import assert from "node:assert/strict";
import { test } from "node:test";
import { Int64, Table, tableToIPC, vectorFromArray } from "apache-arrow";
import {
  Config,
  ConfigProvider,
  Effect,
  Fiber,
  Latch,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import { DatabricksClient } from "../src/index.js";

const clientLayer = (fetch: typeof globalThis.fetch) =>
  DatabricksClient.layer({
    host: "https://workspace.example",
    warehouseId: "warehouse",
    accessToken: Effect.succeed(Redacted.make("test-token")),
    queryTimeout: "1 second",
    requestTimeout: "10 seconds",
    fetch,
  });

const fixture = () => {
  const submitted: Array<{ statement: string; parameters: unknown }> = [];
  const bytes = tableToIPC(
    new Table({ id: vectorFromArray([9007199254740993n], new Int64()) }),
    "stream",
  );
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith("https://storage.example")) return new Response(bytes);
    const body = JSON.parse(await new Request(input, init).text());
    submitted.push(body);
    if (body.format === "JSON_ARRAY") {
      return Response.json({
        statement_id: "statement",
        status: { state: "SUCCEEDED" },
        manifest: {
          format: "JSON_ARRAY",
          total_chunk_count: 1,
          schema: { columns: [{ name: "id" }] },
        },
        result: { data_array: [["9007199254740993"]] },
      });
    }
    return Response.json({
      statement_id: "statement",
      status: { state: "SUCCEEDED" },
      manifest: { format: "ARROW_STREAM", total_chunk_count: 1 },
      result: {
        external_links: [
          { chunk_index: 0, external_link: "https://storage.example/0" },
        ],
      },
    });
  };
  return { fetch, submitted };
};

test("layerConfig supplies the same client under both SQL services", async () => {
  const server = fixture();
  const client = DatabricksClient.layerConfig({
    host: Config.String("host"),
    warehouseId: Config.String("warehouse"),
    accessToken: Config.Redacted("token").pipe(Config.map(Effect.succeed)),
    fetch: Config.succeed(server.fetch),
  });
  const rows = await Effect.runPromise(
    Effect.gen(function* () {
      const sql: SqlClient = yield* DatabricksClient.DatabricksClient;
      assert.equal(sql, yield* SqlClient);
      return yield* sql`SELECT 1 AS id`;
    }).pipe(
      Effect.provide(client),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            host: "https://workspace.example",
            warehouse: "warehouse",
            token: "test-token",
          }),
        ),
      ),
    ),
  );
  assert.deepEqual(rows, [{ id: "9007199254740993" }]);
});

test("layerConfig distinguishes missing config from invalid client options", async () => {
  const client = DatabricksClient.layerConfig({
    host: Config.String("host"),
    warehouseId: Config.succeed("warehouse"),
    accessToken: Config.succeed(Effect.succeed(Redacted.make("test-token"))),
  });
  const errorWith = (values: Record<string, string>) =>
    Effect.runPromise(
      DatabricksClient.DatabricksClient.pipe(
        Effect.provide(client),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(values)),
        ),
        Effect.flip,
      ),
    );

  assert.ok((await errorWith({})) instanceof Config.ConfigError);
  const invalidClient = await errorWith({ host: "invalid-host" });
  assert.ok(invalidClient instanceof SqlError);
  assert.equal(invalidClient.reason.operation, "configure");
});

test(
  "the query deadline aborts an in-flight submission without replaying SQL",
  {
    timeout: 5000,
  },
  async () => {
    const started = Latch.makeUnsafe();
    let submissions = 0;
    let aborted = false;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      submissions++;
      started.openUnsafe();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    };
    const { result, abortedAtDeadline } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        const fiber = yield* sql
          .ipcStream(sql`SELECT 1`)
          .pipe(Stream.runDrain, Effect.result, Effect.forkChild);
        yield* started.await;
        yield* TestClock.adjust("1 second");
        const abortedAtDeadline = aborted;
        // Also release a broken implementation via its independent request timeout.
        yield* TestClock.adjust("9 seconds");
        return { result: yield* Fiber.join(fiber), abortedAtDeadline };
      }).pipe(
        Effect.provide(clientLayer(fetch)),
        Effect.provide(TestClock.layer()),
      ),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.partialDeepStrictEqual(result.failure.reason.cause, {
        reason: "StatementTimeoutError",
      });
      assert.equal(result.failure.reason.operation, "query");
    }
    assert.equal(aborted, true);
    assert.equal(abortedAtDeadline, true);
    assert.equal(submissions, 1);
  },
);

test("all native Arrow APIs apply the statement transformer and SQL tracing", async () => {
  const server = fixture();
  const spans: Parameters<Statement.Transformer>[3][] = [];
  const transformer: Statement.Transformer = (
    _statement,
    sql,
    _fiber,
    span,
  ) => {
    assert.equal(
      sql.onDialectOrElse({ mysql: () => "mysql", orElse: () => "spark" }),
      "spark",
    );
    spans.push(span);
    return Effect.succeed(
      sql.unsafe("SELECT :p1 AS id /* transformed */", [7]),
    );
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const statement = sql`SELECT ${1} AS id`;
      yield* statement;
      yield* sql.arrow(statement);
      yield* Stream.runCollect(sql.arrowChunks(statement));
      yield* Stream.runCollect(sql.arrowStream(statement));
      yield* Stream.runCollect(sql.ipcStream(statement));
      yield* Stream.runCollect(sql.ipcStream(statement, { maxBytes: 4096 }));
    }).pipe(
      Effect.provideService(Statement.CurrentTransformer, transformer),
      Effect.provide(clientLayer(server.fetch)),
    ),
  );
  assert.equal(server.submitted.length, 6);
  for (const { statement, parameters } of server.submitted) {
    assert.equal(statement, "SELECT :p1 AS id /* transformed */");
    assert.deepEqual(parameters, [{ name: "p1", type: "BIGINT", value: "7" }]);
  }
  assert.equal(spans.length, 6);
  for (const span of spans) {
    assert.equal(span.kind, "client");
    assert.equal(span.attributes.get("db.system.name"), "databricks");
    assert.equal(
      span.attributes.get("db.query.text"),
      "SELECT :p1 AS id /* transformed */",
    );
  }
});

for (const shape of [
  "arrowChunks",
  "arrowStream",
  "ipcStream",
  "rows",
] as const) {
  test(`withQueryTimeout interrupts downstream consumption of ${shape}`, async () => {
    const server = fixture();
    let consumerReleased = false;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        const consuming = yield* Latch.make();
        const statement = sql`SELECT 1 AS id`;
        const stream: Stream.Stream<unknown, SqlError> =
          shape === "rows" ? statement.stream : sql[shape](statement);
        const fiber = yield* stream.pipe(
          Stream.runForEach(() =>
            consuming.open.pipe(Effect.andThen(Effect.never)),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              consumerReleased = true;
            }),
          ),
          sql.withQueryTimeout,
          Effect.result,
          Effect.forkChild,
        );
        yield* consuming.await;
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(clientLayer(server.fetch)),
        Effect.provide(TestClock.layer()),
      ),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.partialDeepStrictEqual(result.failure.reason.cause, {
        reason: "StatementTimeoutError",
      });
      assert.equal(result.failure.reason.operation, "query");
    }
    assert.equal(consumerReleased, true);
    assert.equal(server.submitted.length, 1);
  });
}

test("SqlSchema validates decoded rows without losing BIGINT precision", async () => {
  const server = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const execute = (id: bigint) => sql`SELECT ${id} AS id`;
      const find = SqlSchema.findAll({
        Request: Schema.BigInt,
        Result: Schema.Struct({ id: Schema.BigIntFromString }),
        execute,
      });
      assert.deepEqual(yield* find(9007199254740993n), [
        { id: 9007199254740993n },
      ]);
      const invalid = SqlSchema.findAll({
        Request: Schema.BigInt,
        Result: Schema.Struct({ id: Schema.Number }),
        execute,
      });
      const result = yield* Effect.result(invalid(9007199254740993n));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal(result.failure._tag, "SchemaError");
    }).pipe(Effect.provide(clientLayer(server.fetch))),
  );
  assert.equal(server.submitted.length, 2);
});

test("typed parameters compose in IN lists, inserts, and updates", async () => {
  const server = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const date = sql.param("DATE", "2016-01-01");
      const nil = sql.param("DATE", null);
      yield* sql`SELECT * FROM trips WHERE day IN ${sql.in([date, nil])}`;
      yield* sql`SELECT * FROM trips WHERE ${sql.in("day", [date, nil])}`;
      yield* sql`INSERT INTO trips ${sql.insert([{ day: date }, { day: nil }])}`;
      yield* sql`UPDATE trips SET ${sql.update({ day: date })} WHERE day = ${nil}`;
    }).pipe(Effect.provide(clientLayer(server.fetch))),
  );
  assert.deepEqual(
    server.submitted.map(({ statement }) => statement),
    [
      "SELECT * FROM trips WHERE day IN (:p1,:p2)",
      "SELECT * FROM trips WHERE `day` IN (:p1,:p2)",
      "INSERT INTO trips (`day`) VALUES (:p1),(:p2)",
      "UPDATE trips SET `day` = :p1 WHERE day = :p2",
    ],
  );
  for (const { parameters } of server.submitted) {
    assert.deepEqual(parameters, [
      { name: "p1", type: "DATE", value: "2016-01-01" },
      { name: "p2", type: "DATE", value: null },
    ]);
  }
});

test("unsupported SQL helpers and session reservation return typed failures before submission", async () => {
  const server = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const custom = Statement.custom<Statement.Custom<"OtherDriver">>(
        "OtherDriver",
      )(undefined, undefined, undefined);
      const rows = sql`SELECT * FROM ${sql.updateValues([{ id: 1 }], "updates")}`;
      const arrow = sql.arrow(sql`SELECT ${custom}`);
      for (const effect of [Effect.asVoid(rows), Effect.asVoid(arrow)]) {
        const error = yield* Effect.flip(effect);
        assert.ok(error instanceof SqlError);
        assert.equal(error.reason.operation, "compile");
      }
      const error = yield* Effect.flip(sql.reserve);
      assert.equal(error.reason.operation, "reserve");
    }).pipe(Effect.scoped, Effect.provide(clientLayer(server.fetch))),
  );
  assert.equal(server.submitted.length, 0);
});

test("dialect dispatch never selects MySQL for Spark SQL", async () => {
  const server = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      for (const client of [sql, sql.safe, sql.withoutTransforms()]) {
        assert.equal(
          client.onDialectOrElse({
            mysql: () => "mysql",
            orElse: () => "spark",
          }),
          "spark",
        );
        assert.throws(() =>
          client.onDialect({
            sqlite: () => "sqlite",
            pg: () => "pg",
            mysql: () => "mysql",
            mssql: () => "mssql",
            clickhouse: () => "clickhouse",
          }),
        );
      }
    }).pipe(Effect.provide(clientLayer(server.fetch))),
  );
  assert.equal(server.submitted.length, 0);
});

test(
  "bounded IPC cancels an overflowing response even if the warehouse ignores byte_limit",
  {
    timeout: 5000,
  },
  async () => {
    let cancelled = false;
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://storage.example")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(64));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }
      return Response.json({
        statement_id: "statement",
        status: { state: "SUCCEEDED" },
        manifest: { format: "ARROW_STREAM", total_chunk_count: 1 },
        result: {
          external_links: [
            { chunk_index: 0, external_link: "https://storage.example/0" },
          ],
        },
      });
    };
    await assert.rejects(
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* DatabricksClient.DatabricksClient;
          return yield* Stream.runCollect(
            sql.ipcStream(sql`SELECT 1`, { maxBytes: 32 }),
          );
        }).pipe(Effect.provide(clientLayer(fetch))),
      ),
      (error) =>
        error instanceof SqlError &&
        error.reason.message === "Arrow result exceeds the byte limit",
    );
    assert.equal(cancelled, true);
  },
);
