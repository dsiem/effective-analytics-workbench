import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Decimal,
  Int64,
  Table,
  tableFromIPC,
  tableToIPC,
  Utf8,
  vectorFromArray,
} from "apache-arrow";
import { Effect, Fiber, Redacted, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { DatabricksClient } from "../src/index.js";
import { listen } from "./http.js";

const token = "workspace-secret-must-never-reach-storage";
const fixture = (ids: bigint[], names: (string | null)[]) =>
  new Table({
    id: vectorFromArray(ids, new Int64()),
    name: vectorFromArray(names, new Utf8()),
  });
const tables = [
  fixture([9007199254740993n, 2n], ["first", null]),
  fixture([3n], ["last"]),
];

type Request = {
  method: string;
  path: string;
  authorization: string | undefined;
  resultKey: string | string[] | undefined;
  body: Record<string, unknown>;
};
interface Scenario {
  readonly tables?: Table[];
  readonly inline?: {
    readonly columns: string[];
    readonly chunks: (string | null)[][][];
  };
  readonly running?: boolean;
  readonly immediate?: boolean;
  readonly failure?: string;
  readonly truncated?: boolean;
  readonly malformed?: boolean;
  readonly corruptArrow?: boolean;
  readonly expired?: boolean;
  readonly submitStatus?: number;
  readonly transientPoll?: boolean;
  readonly slowDownload?: boolean;
}

const warehouse = async (scenario: Scenario = {}) => {
  const requests: Request[] = [];
  const downloads: Request[] = [];
  let polls = 0;
  let submitted = 0;
  let refreshed = false;
  const chunks = scenario.tables ?? tables;
  const storage = await listen(async (req, res) => {
    const path = req.url ?? "/";
    downloads.push({
      method: req.method ?? "GET",
      path,
      authorization: req.headers.authorization,
      resultKey: req.headers["x-result-key"],
      body: {},
    });
    assert.equal(req.headers.cookie, undefined);
    if (scenario.slowDownload) {
      await new Promise<void>((resolve) => req.on("close", resolve));
      return;
    }
    if (scenario.expired && path.includes("expired")) {
      res.writeHead(403).end();
      return;
    }
    const index = Number(path.split("/").at(-1));
    const table = chunks[index];
    assert.ok(table);
    res.writeHead(200, {
      "Content-Type": "application/vnd.apache.arrow.stream",
    });
    res.end(
      scenario.corruptArrow
        ? Buffer.from("invalid arrow")
        : tableToIPC(table, "stream"),
    );
  });
  const link = (index: number) => ({
    external_links: [
      {
        chunk_index: index,
        external_link: `${storage.origin}/${scenario.expired && !refreshed ? "expired/" : ""}${index}`,
        ...(scenario.expired
          ? {
              http_headers: {
                "X-Result-Key": refreshed ? `chunk-${index}` : "original",
              },
            }
          : {}),
      },
    ],
  });
  const resultChunk = (index: number) =>
    scenario.inline
      ? { chunk_index: index, data_array: scenario.inline.chunks[index] }
      : link(index);
  const chunkCount = scenario.inline?.chunks.length ?? chunks.length;
  const success = (id: string) => ({
    statement_id: id,
    status: { state: "SUCCEEDED" },
    manifest: {
      format: scenario.inline ? "JSON_ARRAY" : "ARROW_STREAM",
      ...(scenario.inline
        ? {
            schema: {
              columns: scenario.inline.columns.map((name) => ({ name })),
            },
          }
        : {}),
      total_chunk_count: chunkCount,
      truncated: scenario.truncated ?? false,
    },
    ...(chunkCount ? { result: resultChunk(0) } : {}),
  });
  const workspace = await listen(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const body = buffers.length
      ? (JSON.parse(Buffer.concat(buffers).toString()) as Record<
          string,
          unknown
        >)
      : {};
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    requests.push({
      method,
      path,
      authorization: req.headers.authorization,
      resultKey: req.headers["x-result-key"],
      body,
    });
    res.setHeader("Content-Type", "application/json");
    if (path === "/api/2.0/sql/statements" && method === "POST") {
      submitted++;
      if (scenario.submitStatus) {
        res
          .writeHead(scenario.submitStatus)
          .end(JSON.stringify({ error: "not accepted" }));
        return;
      }
      const id = `statement-${submitted}`;
      res.end(
        JSON.stringify(
          scenario.malformed
            ? { statement_id: id, status: { state: "SURPRISE" } }
            : scenario.immediate
              ? success(id)
              : { statement_id: id, status: { state: "PENDING" } },
        ),
      );
      return;
    }
    const id = path.split("/")[5] ?? "missing";
    if (path.endsWith("/cancel")) {
      res.end("{}");
    } else if (path.includes("/result/chunks/")) {
      refreshed = true;
      res.end(JSON.stringify(resultChunk(Number(path.split("/").at(-1)))));
    } else {
      polls++;
      if (scenario.transientPoll && polls === 1) {
        res.writeHead(503).end("{}");
        return;
      }
      res.end(
        JSON.stringify(
          scenario.running
            ? { statement_id: id, status: { state: "RUNNING" } }
            : scenario.failure
              ? {
                  statement_id: id,
                  status: {
                    state: scenario.failure,
                    sql_state: "42601",
                    error: { message: "Invalid SQL" },
                  },
                }
              : success(id),
        ),
      );
    }
  });
  let tokenReads = 0;
  const config: DatabricksClient.DatabricksClientConfig = {
    host: workspace.origin,
    warehouseId: "warehouse",
    accessToken: Effect.sync(() => {
      tokenReads++;
      return Redacted.make(token);
    }),
    pollInterval: "1 millis",
    requestTimeout: "1 second",
    queryTimeout: "5 seconds",
  };
  return {
    config,
    requests,
    downloads,
    get tokenReads() {
      return tokenReads;
    },
    run: <A, E>(
      program: Effect.Effect<
        A,
        E,
        DatabricksClient.DatabricksClient | SqlClient.SqlClient
      >,
    ) =>
      Effect.runPromise(
        program.pipe(Effect.provide(DatabricksClient.layer(config))),
      ),
    close: async () => {
      await workspace.close();
      await storage.close();
    },
  };
};

test("queries a SQL warehouse using Arrow and preserves bigint, nulls, and chunk order", async (t) => {
  const server = await warehouse();
  t.after(server.close);
  const table = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* sql.arrow(
        sql`SELECT id, name FROM ${sql("main.analytics.sales")} WHERE id > ${42n}`,
      );
    }),
  );
  assert.ok(table instanceof Table);
  assert.deepEqual(
    [...table].map((row) => row.toJSON()),
    [
      { id: 9007199254740993n, name: "first" },
      { id: 2n, name: null },
      { id: 3n, name: "last" },
    ],
  );
  const request = server.requests[0];
  assert.equal(
    request?.body.statement,
    "SELECT id, name FROM `main`.`analytics`.`sales` WHERE id > :p1",
  );
  assert.equal(request.body.warehouse_id, "warehouse");
  assert.equal(request.body.format, "ARROW_STREAM");
  assert.equal(request.body.disposition, "EXTERNAL_LINKS");
  assert.deepEqual(request.body.parameters, [
    { name: "p1", type: "BIGINT", value: "42" },
  ]);
  assert.equal(server.downloads.length, 2);
  assert.ok(
    server.requests.every(
      (request) => request.authorization === `Bearer ${token}`,
    ),
  );
  assert.ok(
    server.downloads.every((request) => request.authorization === undefined),
  );
  assert.equal(server.tokenReads, server.requests.length);
});

test("provides the generic Effect SQL row, value, raw, and streaming APIs", async (t) => {
  const server = await warehouse({
    immediate: true,
    inline: {
      columns: ["id", "name"],
      chunks: [
        [
          ["9007199254740993", "first"],
          ["2", null],
        ],
        [["3", "last"]],
      ],
    },
  });
  t.after(server.close);
  const result = await server.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        driver: sql.driver,
        rows: yield* sql`SELECT * FROM sales`,
        values: yield* sql`SELECT * FROM sales`.values,
        raw: yield* sql`SELECT * FROM sales`.raw,
        batches: yield* Stream.runCollect(
          Stream.chunks(sql`SELECT * FROM sales`.stream),
        ),
        unprepared: yield* sql`SELECT * FROM sales`.unprepared,
        unpreparedValues: yield* sql`SELECT * FROM sales`.valuesUnprepared,
      };
    }),
  );
  assert.equal(result.driver, "databricks");
  assert.deepEqual(result.rows, [
    { id: "9007199254740993", name: "first" },
    { id: "2", name: null },
    { id: "3", name: "last" },
  ]);
  assert.deepEqual(result.batches, [
    result.rows.slice(0, 2),
    result.rows.slice(2),
  ]);
  assert.deepEqual(result.unprepared, result.rows);
  assert.deepEqual(result.values, [
    ["9007199254740993", "first"],
    ["2", null],
    ["3", "last"],
  ]);
  assert.deepEqual(result.unpreparedValues, result.values);
  assert.deepEqual(result.raw, result.rows);
  const submissions = server.requests.filter((req) => req.method === "POST");
  assert.equal(submissions.length, 6);
  for (const { body } of submissions) {
    assert.equal(body.format, "JSON_ARRAY");
    assert.equal(body.disposition, "INLINE");
  }
  assert.deepEqual(server.downloads, []);
});

test("streams Arrow batches and independently decodable IPC chunks", async (t) => {
  const server = await warehouse();
  t.after(server.close);
  const [batches, ipc] = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return [
        yield* Stream.runCollect(sql.arrowStream(sql`SELECT * FROM sales`)),
        yield* Stream.runCollect(sql.ipcStream(sql`SELECT * FROM sales`)),
      ] as const;
    }),
  );
  assert.deepEqual(
    batches.map((batch) => batch.numRows),
    [2, 1],
  );
  assert.deepEqual(
    ipc.map((bytes) => tableFromIPC(bytes).numRows),
    [2, 1],
  );
});

test("bounded IPC limits cumulative downloads and validates limits before submitting", async (t) => {
  const server = await warehouse();
  t.after(server.close);
  const size = tables.reduce(
    (total, table) => total + tableToIPC(table, "stream").byteLength,
    0,
  );
  const success = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* Stream.runCollect(
        sql.ipcStream(sql`SELECT * FROM sales`, { maxBytes: size }),
      );
    }),
  );
  assert.equal(success.length, 2);
  await assert.rejects(
    server.run(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        return yield* Stream.runCollect(
          sql.ipcStream(sql`SELECT * FROM sales`, { maxBytes: size - 1 }),
        );
      }),
    ),
  );
  assert.equal(
    server.requests.find((r) => r.method === "POST")?.body.byte_limit,
    size,
  );
  const before = server.requests.length;
  for (const maxBytes of [0, -1, Number.NaN]) {
    await assert.rejects(
      server.run(
        Effect.gen(function* () {
          const sql = yield* DatabricksClient.DatabricksClient;
          return yield* Stream.runCollect(
            sql.ipcStream(sql`SELECT * FROM sales`, { maxBytes }),
          );
        }),
      ),
    );
  }
  assert.equal(server.requests.length, before);
});

test("stops downloading when an Arrow stream consumer stops", async (t) => {
  const server = await warehouse();
  t.after(server.close);
  const result = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* Stream.runCollect(
        sql.arrowChunks(sql`SELECT * FROM sales`).pipe(Stream.take(1)),
      );
    }),
  );
  assert.equal(result.length, 1);
  assert.equal(server.downloads.length, 1);
  assert.ok(
    server.requests.every((request) => !request.path.endsWith("/chunks/1")),
  );
});

test("binds primitives, explicit decimals, dates, and typed nulls as named parameters", async (t) => {
  const server = await warehouse();
  t.after(server.close);
  await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      yield* sql.arrow(
        sql`SELECT ${"a' OR 1=1"}, ${true}, ${1.5}, ${null}, ${new Date("2026-01-01Z")}, ${sql.param("DECIMAL(38,2)", "12345678901234567890.12")}, ${sql.param("DATE", null)}`,
      );
    }),
  );
  assert.equal(
    server.requests[0]?.body.statement,
    "SELECT :p1, :p2, :p3, :p4, :p5, :p6, :p7",
  );
  assert.deepEqual(server.requests[0]?.body.parameters, [
    { name: "p1", type: "STRING", value: "a' OR 1=1" },
    { name: "p2", type: "BOOLEAN", value: "true" },
    { name: "p3", type: "DOUBLE", value: "1.5" },
    { name: "p4", type: "STRING", value: null },
    { name: "p5", type: "TIMESTAMP", value: "2026-01-01T00:00:00.000Z" },
    { name: "p6", type: "DECIMAL(38,2)", value: "12345678901234567890.12" },
    { name: "p7", type: "DATE", value: null },
  ]);
});

test("preserves the Arrow schema for an empty result and supports statements without result chunks", async (t) => {
  const empty = fixture([], []);
  const server = await warehouse({ tables: [empty] });
  t.after(server.close);
  const result = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* sql.arrow(sql`SELECT * FROM sales WHERE false`);
    }),
  );
  assert.equal(result.numRows, 0);
  assert.deepEqual(
    result.schema.fields.map((field) => [field.name, field.type.toString()]),
    [
      ["id", "Int64"],
      ["name", "Utf8"],
    ],
  );
  const noResult = await warehouse({ tables: [] });
  t.after(noResult.close);
  assert.equal(
    (
      await noResult.run(
        Effect.gen(function* () {
          const sql = yield* DatabricksClient.DatabricksClient;
          return yield* sql.arrow(sql`CREATE TABLE example (id BIGINT)`);
        }),
      )
    ).numRows,
    0,
  );
});

test("uses each signed link's headers, including after refresh, only on its storage request", async (t) => {
  const server = await warehouse({ expired: true });
  t.after(server.close);
  const table = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* sql.arrow(sql`SELECT * FROM sales`);
    }),
  );
  assert.equal(table.numRows, 3);
  assert.equal(server.downloads.length, 3);
  assert.deepEqual(
    server.downloads.map((request) => request.resultKey),
    ["original", "chunk-0", "chunk-1"],
  );
  assert.ok(
    server.requests.every((request) => request.resultKey === undefined),
  );
  assert.ok(
    server.downloads.every((request) => request.authorization === undefined),
  );
});

for (const scenario of [
  { failure: "FAILED" },
  { failure: "CANCELED" },
  { failure: "CLOSED" },
  { truncated: true },
  { malformed: true },
  { corruptArrow: true },
]) {
  test(`reports typed errors for ${JSON.stringify(scenario)}`, async (t) => {
    const server = await warehouse(scenario);
    t.after(server.close);
    const result = await server.run(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        return yield* Effect.result(sql.arrow(sql`SELECT * FROM sales`));
      }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure._tag, "SqlError");
      assert.equal(
        result.failure.reason.operation,
        "malformed" in scenario
          ? "decode"
          : "corruptArrow" in scenario
            ? "decodeArrow"
            : "truncated" in scenario
              ? "manifest"
              : "execute",
      );
      assert.ok(!JSON.stringify(result.failure).includes(token));
      assert.ok(!JSON.stringify(result.failure).includes("http://127.0.0.1"));
    }
  });
}

test("retries transient metadata requests but never replays a SQL submission", async (t) => {
  const server = await warehouse({ transientPoll: true });
  t.after(server.close);
  await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      yield* sql.arrow(sql`SELECT * FROM sales`);
    }),
  );
  assert.equal(
    server.requests.filter((request) => request.method === "POST").length,
    1,
  );
  assert.equal(
    server.requests.filter(
      (request) => request.path === "/api/2.0/sql/statements/statement-1",
    ).length,
    2,
  );
  const rejected = await warehouse({ submitStatus: 503 });
  t.after(rejected.close);
  await assert.rejects(
    rejected.run(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        yield* sql`UPDATE sales SET name = 'new'`;
      }),
    ),
  );
  assert.equal(rejected.requests.length, 1);
});

test("cancels a running warehouse statement when the query deadline expires", async (t) => {
  const server = await warehouse({ running: true });
  t.after(server.close);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* Effect.result(sql.arrow(sql`SELECT * FROM sales`));
    }).pipe(
      Effect.provide(
        DatabricksClient.layer({ ...server.config, queryTimeout: "40 millis" }),
      ),
    ),
  );
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure")
    assert.partialDeepStrictEqual(result.failure.reason.cause, {
      reason: "StatementTimeoutError",
    });
  assert.equal(
    server.requests.filter((request) => request.path.endsWith("/cancel"))
      .length,
    1,
  );
});

test("cancels a running statement when its Effect fiber is interrupted", async (t) => {
  const server = await warehouse({ running: true });
  t.after(server.close);
  await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const fiber = yield* sql
        .arrow(sql`SELECT * FROM sales`)
        .pipe(Effect.forkChild);
      // Observe the public HTTP request before interrupting, without a timing assumption.
      yield* Effect.promise(async () => {
        while (server.requests.length < 2)
          await new Promise((resolve) => setImmediate(resolve));
      });
      yield* Fiber.interrupt(fiber);
    }),
  );
  assert.equal(
    server.requests.filter((request) => request.path.endsWith("/cancel"))
      .length,
    1,
  );
});

test("rejects transactions and unsafe parameter values before submitting SQL", async (t) => {
  const server = await warehouse();
  t.after(server.close);
  await assert.rejects(
    server.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(sql`SELECT 1`);
      }),
    ),
  );
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    9007199254740992,
    {},
  ]) {
    await assert.rejects(
      server.run(
        Effect.gen(function* () {
          const sql = yield* DatabricksClient.DatabricksClient;
          yield* sql.arrow(sql`SELECT ${value}`);
        }),
      ),
    );
  }
  assert.equal(server.requests.length, 0);
});

test("a stalled Arrow body is aborted by the request timeout", async (t) => {
  const server = await warehouse({ slowDownload: true });
  t.after(server.close);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* Effect.result(sql.arrow(sql`SELECT * FROM sales`));
    }).pipe(
      Effect.provide(
        DatabricksClient.layer({
          ...server.config,
          requestTimeout: "40 millis",
        }),
      ),
    ),
  );
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure") {
    assert.partialDeepStrictEqual(result.failure.reason.cause, {
      reason: "StatementTimeoutError",
    });
    assert.equal(result.failure.reason.operation, "download");
  }
});

test("preserves decimal precision and scale in columnar results", async (t) => {
  const server = await warehouse({
    tables: [
      new Table({
        amount: vectorFromArray(
          [new Uint32Array([12345, 0, 0, 0]), null],
          new Decimal(2, 20, 128),
        ),
      }),
    ],
  });
  t.after(server.close);
  const result = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* sql.arrow(sql`SELECT amount FROM sales`);
    }),
  );
  const amount = result.getChild("amount");
  assert.ok(amount);
  assert.equal(amount.type.toString(), "Decimal[20e+2]");
  assert.deepEqual([...amount.get(0)], [12345, 0, 0, 0]);
  assert.equal(amount.get(1), null);
});

test("values preserve SQL column order and duplicate column names", async (t) => {
  const server = await warehouse({
    inline: { columns: ["2", "1", "2"], chunks: [[["a", "b", "c"]]] },
  });
  t.after(server.close);
  await server.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statement = sql`SELECT 'a' AS \`2\`, 'b' AS \`1\`, 'c' AS \`2\``;
      assert.deepEqual(yield* statement.values, [["a", "b", "c"]]);
      assert.deepEqual(yield* statement.valuesUnprepared, [["a", "b", "c"]]);
    }),
  );
  assert.deepEqual(server.downloads, []);
});

test("isolates concurrent statements and allows the same Arrow stream to be rerun", async (t) => {
  const server = await warehouse();
  t.after(server.close);
  const result = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const stream = sql.arrowChunks(sql`SELECT * FROM sales`);
      return yield* Effect.all(
        [Stream.runCollect(stream), Stream.runCollect(stream)],
        { concurrency: "unbounded" },
      );
    }),
  );
  assert.deepEqual(
    result.map((chunks) => chunks.map((table) => table.numRows)),
    [
      [2, 1],
      [2, 1],
    ],
  );
  assert.equal(
    server.requests.filter((request) => request.method === "POST").length,
    2,
  );
  assert.ok(
    server.requests.some((request) =>
      request.path.endsWith("statement-1/result/chunks/1"),
    ),
  );
  assert.ok(
    server.requests.some((request) =>
      request.path.endsWith("statement-2/result/chunks/1"),
    ),
  );
});

test("rejects incompatible Arrow schemas across chunks", async (t) => {
  const server = await warehouse({
    tables: [
      tables[0] as Table,
      new Table({ different: vectorFromArray([1n], new Int64()) }),
    ],
  });
  t.after(server.close);
  const result = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* Effect.result(sql.arrow(sql`SELECT * FROM sales`));
    }),
  );
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure")
    assert.equal(result.failure.reason.operation, "decodeArrow");
});

test("managed app storage proxy is explicitly scoped and never receives workspace credentials", async () => {
  const ipc = tableToIPC(fixture([1n, 2n], ["first", "second"]), "stream");
  for (const [enabled, externalLink, allowed] of [
    [
      false,
      "http://storage-proxy.databricks.com/result?signature=signed-secret",
      false,
    ],
    [
      true,
      "http://storage-proxy.databricks.com/result?signature=signed-secret",
      true,
    ],
    [true, "http://storage-proxy.databricks.com.evil.example/result", false],
    [true, "http://untrusted.example/result", false],
    [true, "http://secret@storage-proxy.databricks.com/result", false],
    [true, "http://storage-proxy.databricks.com:8080/result", false],
    [true, "http://storage-proxy.databricks.com/result#secret", false],
  ] as const) {
    let downloaded = false;
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const sql = yield* DatabricksClient.DatabricksClient;
          return yield* sql.arrow(sql`SELECT 1`);
        }).pipe(
          Effect.provide(
            DatabricksClient.layer({
              host: "https://workspace.example",
              warehouseId: "warehouse",
              accessToken: Effect.succeed(Redacted.make(token)),
              allowDatabricksStorageProxy: enabled,
              fetch: async (input, init) => {
                const url =
                  input instanceof Request ? input.url : input.toString();
                if (new URL(url).hostname !== "workspace.example") {
                  downloaded = true;
                  assert.equal(
                    new Headers(init?.headers).get("Authorization"),
                    null,
                  );
                  assert.equal(init?.credentials, "omit");
                  assert.equal(init?.redirect, "error");
                  return new Response(ipc);
                }
                return Response.json({
                  statement_id: "statement",
                  status: { state: "SUCCEEDED" },
                  manifest: { format: "ARROW_STREAM", total_chunk_count: 1 },
                  result: {
                    external_links: [
                      {
                        chunk_index: 0,
                        external_link: externalLink,
                      },
                    ],
                  },
                });
              },
            }),
          ),
        ),
      ),
    );
    assert.equal(downloaded, allowed, externalLink);
    assert.equal(result._tag, allowed ? "Success" : "Failure", externalLink);
    if (result._tag === "Success") assert.equal(result.success.numRows, 2);
    else assert.ok(!JSON.stringify(result.failure).includes("signed-secret"));
  }
});
