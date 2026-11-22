import assert from "node:assert/strict";
import { test } from "node:test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { Effect, Redacted, Stream } from "effect";
import { SqlError } from "effect/sql/SqlError";
import { DatabricksClient } from "../src/index.js";

type RowCountSource = "manifest" | "result" | "link" | "total";

const fixture = (
  chunks: ReadonlyArray<Uint8Array>,
  rowCounts?: {
    readonly source: RowCountSource;
    readonly counts: ReadonlyArray<number>;
  },
) => {
  const downloads: number[] = [];
  const chunk = (index: number) => ({
    chunk_index: index,
    ...(rowCounts?.source === "result"
      ? { row_count: rowCounts.counts[index] }
      : {}),
    external_links: [
      {
        chunk_index: index,
        external_link: `https://storage.example/${index}`,
        ...(rowCounts?.source === "link"
          ? { row_count: rowCounts.counts[index] }
          : {}),
      },
    ],
  });
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const index = Number(url.pathname.split("/").at(-1));
    if (url.hostname === "storage.example") {
      downloads.push(index);
      const bytes = chunks[index];
      assert.ok(bytes);
      return new Response(new Uint8Array(bytes));
    }
    if (url.pathname.includes("/chunks/")) {
      return Response.json(chunk(index));
    }
    return Response.json({
      statement_id: "statement",
      status: { state: "SUCCEEDED" },
      manifest: {
        format: "ARROW_STREAM",
        total_chunk_count: chunks.length,
        ...(rowCounts?.source === "total"
          ? { total_row_count: rowCounts.counts.reduce((sum, n) => sum + n, 0) }
          : {}),
        ...(rowCounts?.source === "manifest"
          ? {
              chunks: rowCounts.counts.map((row_count, chunk_index) => ({
                chunk_index,
                row_count,
              })),
            }
          : {}),
      },
      result: chunk(0),
    });
  };
  const layer = DatabricksClient.layer({
    host: "https://workspace.example",
    warehouseId: "warehouse",
    accessToken: Effect.succeed(Redacted.make("test-token")),
    fetch,
  });
  return {
    downloads,
    run<A, E>(effect: Effect.Effect<A, E, DatabricksClient.DatabricksClient>) {
      return Effect.runPromise(Effect.provide(effect, layer));
    },
  };
};

const arrowDecodeError = (error: unknown) =>
  error instanceof SqlError && error.reason.operation === "decodeArrow";

test("decoded Arrow results reject junk bytes while raw IPC preserves them", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const server = fixture([bytes]);
  const { raw, rows } = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const statement = sql`SELECT 1`;
      return {
        raw: yield* Stream.runCollect(sql.ipcStream(statement)),
        rows: yield* Effect.result(sql.arrow(statement)),
      };
    }),
  );

  assert.deepEqual(raw, [bytes]);
  assert.equal(rows._tag, "Failure");
  assert.ok(arrowDecodeError(rows.failure));
});

for (const source of ["manifest", "result", "link", "total"] as const) {
  test(`decoded Arrow rejects a row count mismatch from ${source} metadata`, async () => {
    const validPartial = tableToIPC(tableFromArrays({ id: [1, 2] }), "stream");
    const server = fixture([validPartial, validPartial], {
      source,
      counts: [2, 3],
    });
    const result = await server.run(
      Effect.gen(function* () {
        const sql = yield* DatabricksClient.DatabricksClient;
        return yield* Effect.result(sql.arrow(sql`SELECT id FROM sales`));
      }),
    );

    assert.equal(result._tag, "Failure");
    assert.ok(arrowDecodeError(result.failure));
  });
}

test("decoded chunk streams reject schema changes without prefetching", async () => {
  const first = tableToIPC(tableFromArrays({ id: [1] }), "stream");
  const changed = tableToIPC(tableFromArrays({ id: ["x"] }), "stream");
  const server = fixture([first, changed]);
  const firstRows = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* sql
        .arrowChunks(sql`SELECT id FROM sales`)
        .pipe(Stream.take(1), Stream.runCollect);
    }),
  );
  assert.deepEqual(
    firstRows.flatMap((table) => [...table].map((row) => row.toJSON())),
    [{ id: 1 }],
  );
  assert.deepEqual(server.downloads, [0]);

  const failures = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      const statement = sql`SELECT id FROM sales`;
      return yield* Effect.all([
        Effect.result(sql.arrow(statement)),
        Effect.result(Stream.runCollect(sql.arrowChunks(statement))),
        Effect.result(Stream.runCollect(sql.arrowStream(statement))),
      ]);
    }),
  );
  for (const result of failures) {
    assert.equal(result._tag, "Failure");
    assert.ok(arrowDecodeError(result.failure));
  }
});

test("schema-only chunks keep their fields and accept a zero row count", async () => {
  const bytes = tableToIPC(tableFromArrays({ id: new Int32Array() }), "stream");
  const server = fixture([bytes], { source: "link", counts: [0] });
  const table = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* sql.arrow(sql`SELECT id FROM sales WHERE FALSE`);
    }),
  );

  assert.equal(table.numRows, 0);
  assert.deepEqual(
    table.schema.fields.map((field) => [field.name, field.type.toString()]),
    [["id", "Int32"]],
  );
});

test("zero chunks cannot account for a positive manifest row count", async () => {
  const server = fixture([], { source: "total", counts: [1] });
  const result = await server.run(
    Effect.gen(function* () {
      const sql = yield* DatabricksClient.DatabricksClient;
      return yield* Effect.result(sql.arrow(sql`SELECT id FROM sales`));
    }),
  );

  assert.equal(result._tag, "Failure");
  assert.ok(arrowDecodeError(result.failure));
  assert.deepEqual(server.downloads, []);
});
