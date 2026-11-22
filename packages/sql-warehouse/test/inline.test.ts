import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted, Stream } from "effect";
import { DatabricksClient } from "../src/index.js";

const manifest = {
  format: "JSON_ARRAY",
  schema: {
    columns: [
      { name: "zip", type_name: "STRING" },
      { name: "fare", type_name: "DOUBLE" },
      { name: "id", type_name: "LONG" },
      { name: "total", type_name: "DECIMAL" },
      { name: "paid", type_name: "BOOLEAN" },
    ],
  },
  total_chunk_count: 2,
  total_row_count: 2,
};

const first = {
  chunk_index: 0,
  next_chunk_index: 1,
  row_count: 1,
  data_array: [["00123", "42.75", "9007199254740993", "8.0200", "false"]],
};
const second = {
  chunk_index: 1,
  row_offset: 1,
  row_count: 1,
  data_array: [[null, null, null, null, null]],
};

const warehouse = (meta: unknown, firstChunk: unknown, nextChunk?: unknown) => {
  const chunkRequests: string[] = [];
  const path = "/api/2.0/sql/statements";
  const layer = DatabricksClient.layer({
    host: "https://workspace.example",
    warehouseId: "warehouse",
    accessToken: Effect.succeed(Redacted.make("token")),
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.hostname, "workspace.example");
      if (url.pathname === path) {
        return Response.json({
          statement_id: "id",
          status: { state: "SUCCEEDED" },
          manifest: meta,
          result: firstChunk,
        });
      }
      assert.equal(url.pathname, path + "/id/result/chunks/1");
      chunkRequests.push(url.pathname);
      return Response.json(nextChunk);
    },
  });
  const rows = Stream.unwrap(
    Effect.map(
      DatabricksClient.DatabricksClient,
      (sql) => sql`SELECT * FROM trips`.stream,
    ),
  ).pipe(Stream.provide(layer));
  return { rows, chunkRequests };
};

test("inline rows preserve wire values and fetch later chunks on demand", async () => {
  const server = warehouse(manifest, first, second);
  const chunks = server.rows.pipe(Stream.chunks);
  const firstRow = {
    zip: "00123",
    fare: "42.75",
    id: "9007199254740993",
    total: "8.0200",
    paid: "false",
  };
  assert.deepEqual(
    await Effect.runPromise(Stream.runCollect(chunks.pipe(Stream.take(1)))),
    [[firstRow]],
  );
  assert.deepEqual(server.chunkRequests, []);
  assert.deepEqual(await Effect.runPromise(Stream.runCollect(chunks)), [
    [firstRow],
    [{ zip: null, fare: null, id: null, total: null, paid: null }],
  ]);
  assert.deepEqual(server.chunkRequests, [
    "/api/2.0/sql/statements/id/result/chunks/1",
  ]);
});

test("inline statements accept zero rows without fetching another chunk", async () => {
  const server = warehouse(
    { ...manifest, total_chunk_count: 0, total_row_count: 0 },
    undefined,
  );
  const rows = await Effect.runPromise(Stream.runCollect(server.rows));
  assert.deepEqual(server.chunkRequests, []);
  assert.deepEqual(rows, []);
});

test("inline streams fail for truncated, malformed, or incomplete results", async () => {
  for (const [meta, chunk, error] of [
    [{ ...manifest, truncated: true }, second, /Truncated inline JSON/],
    [
      { ...manifest, schema: { columns: [{ name: "a" }, { name: "a" }] } },
      second,
      /Duplicate inline JSON column names/,
    ],
    [manifest, { ...second, data_array: [["x"]] }, /Invalid inline JSON row/],
    [
      manifest,
      { ...second, data_array: [["x", 42, "1", "0", "false"]] },
      /Invalid inline JSON chunk/,
    ],
    [manifest, { ...second, row_count: 2 }, /does not match result metadata/],
    [manifest, { ...second, row_offset: 0 }, /does not match result metadata/],
    [manifest, { ...second, chunk_index: 0 }, /does not match result metadata/],
    [
      { ...manifest, total_row_count: 3 },
      second,
      /row count does not match manifest/,
    ],
  ] as const) {
    await assert.rejects(
      Effect.runPromise(Stream.runCollect(warehouse(meta, first, chunk).rows)),
      error,
    );
  }
});
