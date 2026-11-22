import assert from "node:assert/strict";
import { Config, Effect } from "effect";
import { Credentials, DatabricksClient } from "../dist/index.js";

// This read-only query works on any warehouse without access to user tables.
const program = Effect.gen(function* () {
  const host = yield* Config.String("DATABRICKS_HOST");
  const warehouseId = yield* Config.String("DATABRICKS_WAREHOUSE_ID");
  const accessToken = process.env.DATABRICKS_TOKEN
    ? Effect.succeed(yield* Config.Redacted("DATABRICKS_TOKEN"))
    : Credentials.clientCredentials({
        host,
        clientId: yield* Config.String("DATABRICKS_CLIENT_ID"),
        clientSecret: yield* Config.Redacted("DATABRICKS_CLIENT_SECRET"),
      });
  return yield* Effect.gen(function* () {
    const sql = yield* DatabricksClient.DatabricksClient;
    const statement = sql`SELECT ${9007199254740993n} AS id, CAST(NULL AS STRING) AS missing, ${sql.param("DECIMAL(20,2)", "123456789012345678.12")} AS amount`;
    assert.deepEqual(yield* statement, [
      {
        id: "9007199254740993",
        missing: null,
        amount: "123456789012345678.12",
      },
    ]);
    const table = yield* sql.arrow(statement);
    assert.equal(table.numRows, 1);
    assert.equal(table.getChild("id")?.get(0), 9007199254740993n);
    assert.equal(table.getChild("missing")?.get(0), null);
    assert.equal(table.getChild("amount")?.type.toString(), "Decimal[20e+2]");
    console.log(
      "Live Databricks query passed with default inline JSON and explicit Arrow",
    );
  }).pipe(
    Effect.provide(DatabricksClient.layer({ host, warehouseId, accessToken })),
  );
});

await Effect.runPromise(program);
