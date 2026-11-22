import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { DatabricksClient } from "../src/index.js";

const path = "/api/2.0/sql/statements";
const id = "page-test";
const statusPath = `${path}/${id}`;
const makeLayer = (fetch: typeof globalThis.fetch) =>
  DatabricksClient.layer({
    host: "https://workspace.example",
    warehouseId: "warehouse",
    accessToken: Effect.succeed(Redacted.make("test-token")),
    pollInterval: "1 millis",
    byteLimit: 4096,
    fetch,
  });

const complete = (manifest: unknown, result?: unknown) => ({
  statement_id: id,
  status: { state: "SUCCEEDED" },
  manifest,
  result,
});
const manifest = {
  format: "JSON_ARRAY",
  schema: { columns: [{ name: "id" }] },
  chunks: [
    { chunk_index: 0, row_offset: 0, row_count: 1 },
    { chunk_index: 1, row_offset: 1, row_count: 1 },
  ],
  total_chunk_count: 2,
  total_row_count: 2,
  truncated: true,
};

test("page queries return named rows with a single bound submission", async () => {
  const first =
    JSON.stringify(
      complete(manifest, {
        chunk_index: 0,
        next_chunk_index: 1,
        row_count: 1,
        data_array: [["é"]],
      }),
      null,
      3,
    ) + "\n";
  const second =
    '{ "chunk_index":1, "row_offset":1, "row_count":1, "data_array": [ ["\\u0061"] ] }\r\n';
  const requests: string[] = [];
  const layer = makeLayer(async (input, init) => {
    const request = new Request(input, init);
    const { origin, pathname } = new URL(request.url);
    requests.push(pathname);
    assert.equal(origin, "https://workspace.example");
    assert.equal(request.headers.get("authorization"), "Bearer test-token");
    if (pathname === path) {
      const body = await request.json();
      assert.equal(request.method, "POST");
      assert.deepEqual(body, {
        statement: "SELECT :p1",
        parameters: [{ name: "p1", type: "BIGINT", value: "123" }],
        row_limit: 2,
        byte_limit: 4096,
        format: "JSON_ARRAY",
        disposition: "INLINE",
        wait_timeout: "0s",
        warehouse_id: "warehouse",
      });
      return Response.json({ statement_id: id, status: { state: "PENDING" } });
    }
    assert.equal(request.method, "GET");
    return new Response(pathname === statusPath ? first : second);
  });
  const { page, continuation } = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const page = yield* sql.jsonPage(sql`SELECT ${123}`, { rowLimit: 2 });
      yield* Effect.flip(page.readChunk(page.pageCount, 1));
      assert.deepEqual(requests, [path, statusPath]);
      const continuation = yield* page.readChunk(1, 1);
      return { page, continuation };
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(page.pageCount, 2);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.rows, [{ id: "é" }]);
  assert.deepEqual(continuation, [{ id: "a" }]);
  assert.deepEqual(requests, [
    path,
    statusPath,
    `${statusPath}/result/chunks/1`,
  ]);
});

test("an empty page returns no rows or chunks", async () => {
  const raw = JSON.stringify(
    complete({
      format: "JSON_ARRAY",
      total_chunk_count: 0,
      total_row_count: 0,
    }),
    null,
    2,
  );
  const page = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* sql.jsonPage(sql`SELECT 1 WHERE false`, { rowLimit: 1 });
    }).pipe(Effect.provide(makeLayer(async () => new Response(raw)))),
  );
  assert.equal(page.pageCount, 0);
  assert.deepEqual(page.rows, []);
  assert.equal(page.truncated, false);
});

test("pages reject failures, external links and byte-limit truncation", async () => {
  const first = complete(manifest, { data_array: [["first"]] });
  const secret = "https://storage.example/signed-secret";
  const external = {
    data_array: [["row"]],
    external_links: [{ external_link: secret }],
  };
  for (const [method, payload] of [
    ["first", complete(manifest, external)],
    ["chunk", external],
    [
      "first",
      complete({ ...manifest, total_row_count: 1 }, { data_array: [["row"]] }),
    ],
    ["first", { statement_id: id, status: { state: "FAILED" } }],
    ["chunk", { chunk_index: 99, data_array: [["row"]] }],
  ] as const) {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        const query = sql.jsonPage(sql`SELECT 1`, { rowLimit: 2 });
        if (method === "first") return yield* Effect.flip(query);
        const page = yield* query;
        return yield* Effect.flip(page.readChunk(1, 1));
      }).pipe(
        Effect.provide(
          makeLayer(async (input, init) => {
            const request = new Request(input, init);
            return Response.json(
              method === "chunk" && request.method === "POST" ? first : payload,
            );
          }),
        ),
      ),
    );
    assert.doesNotMatch(JSON.stringify(failure), /signed-secret/);
  }
});

test("a denied poll cancels the known page statement and preserves its identity", async () => {
  const requests: string[] = [];
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* Effect.flip(sql.jsonPage(sql`SELECT 1`, { rowLimit: 2 }));
    }).pipe(
      Effect.provide(
        makeLayer(async (input) => {
          const { pathname } = new URL(
            input instanceof Request ? input.url : input,
          );
          requests.push(pathname);
          if (pathname === path)
            return Response.json({
              statement_id: id,
              status: { state: "RUNNING" },
            });
          return new Response(null, {
            status: pathname === statusPath ? 403 : 204,
          });
        }),
      ),
    ),
  );
  assert.deepEqual(requests, [path, statusPath, statusPath + "/cancel"]);
  assert.equal(error.reason._tag, "AuthorizationError");
  assert.deepEqual(error.reason.cause, { statementId: id });
});
