import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { Config, ConfigProvider, Effect, Stream } from "effect";

// Import and execute the actual distribution, outside the source tree. This
// catches missing runtime files and bad package exports without a registry.
const directory = mkdtempSync(join(tmpdir(), "sql-warehouse-package-"));
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--workspace",
        "@dsiem/sql-warehouse",
        "--pack-destination",
        directory,
        "--cache",
        join(directory, "cache"),
        "--json",
        "--silent",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(packed.length, 1);
  execFileSync("tar", [
    "-xzf",
    join(directory, packed[0].filename),
    "-C",
    directory,
  ]);
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "dir");
  const consumer = join(directory, "package/consumer.mjs");
  writeFileSync(consumer, 'export * from "@dsiem/sql-warehouse";\n');
  const exports = await import(pathToFileURL(consumer));
  assert.equal("makeCompiler" in exports.DatabricksClient, false);
  const ipc = tableToIPC(
    tableFromArrays({ id: BigInt64Array.of(9007199254740993n) }),
    "stream",
  );
  const submissions = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://storage.example/0") return new Response(ipc);
    assert.equal(
      request.url,
      "https://workspace.example/api/2.0/sql/statements",
    );
    const { format, disposition } = await request.json();
    submissions.push([format, disposition]);
    const inline = format === "JSON_ARRAY";
    return Response.json({
      statement_id: "packed-statement",
      status: { state: "SUCCEEDED" },
      manifest: {
        format,
        total_chunk_count: 1,
        schema: { columns: [{ name: "id", type_name: "LONG" }] },
      },
      result: inline
        ? { data_array: [["9007199254740993"]] }
        : {
            external_links: [
              { chunk_index: 0, external_link: "https://storage.example/0" },
            ],
          },
    });
  };
  const { table, rows, streamed } = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* exports.DatabricksClient.DatabricksClient;
      const statement = sql`SELECT ${9007199254740993n} AS id`;
      return {
        rows: yield* statement,
        streamed: yield* Stream.runCollect(sql.jsonStream(statement)),
        table: yield* sql.arrow(statement),
      };
    }).pipe(
      Effect.provide(
        exports.DatabricksClient.layerConfig(
          Config.all({
            host: Config.String("DATABRICKS_HOST"),
            warehouseId: Config.String("DATABRICKS_WAREHOUSE_ID"),
            accessToken: Config.Redacted("DATABRICKS_TOKEN").pipe(
              Config.map(Effect.succeed),
            ),
            fetch: Config.succeed(fetch),
          }),
        ),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            DATABRICKS_HOST: "https://workspace.example",
            DATABRICKS_WAREHOUSE_ID: "warehouse",
            DATABRICKS_TOKEN: "test-token",
          }),
        ),
      ),
    ),
  );
  assert.deepEqual(submissions, [
    ["JSON_ARRAY", "INLINE"],
    ["JSON_ARRAY", "INLINE"],
    ["ARROW_STREAM", "EXTERNAL_LINKS"],
  ]);
  assert.deepEqual(rows, [{ id: "9007199254740993" }]);
  assert.deepEqual(streamed, rows);
  assert.equal(table.getChild("id").get(0), 9007199254740993n);
  console.log(
    "Packed Databricks SQL adapter imported and executed Arrow and inline JSON queries",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
