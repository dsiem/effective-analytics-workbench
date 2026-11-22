# SQL Warehouse Adapter for Effect

Query a Databricks SQL warehouse from Node.js 22.19+ with Effect `~4.1.4`. The adapter provides Effect's `SqlClient` for rows and `DatabricksClient` for inline JSON and Apache Arrow results.

This project is independently maintained and is not affiliated with or endorsed by Databricks, Inc.

## Install from this workspace

Run `npm ci` and `npm pack --workspace @dsiem/sql-warehouse --pack-destination /tmp` at the repository root. In your application, run `npm install /tmp/dsiem-sql-warehouse-0.1.0.tgz effect@4.1.4`.

## A small query helper

`countRows` quotes the table identifier and decodes the warehouse count as a `bigint`. The helper only needs Effect's `SqlClient`. Supply the Databricks layer once at application startup.

```ts
import { Config, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { DatabricksClient } from "@dsiem/sql-warehouse";

const countRows = SqlSchema.findOne({
  Request: Schema.String,
  Result: Schema.Struct({ total: Schema.BigIntFromString }),
  execute: (table) =>
    SqlClient.use((sql) => sql`SELECT COUNT(*) AS total FROM ${sql(table)}`),
});

const Warehouse = DatabricksClient.layerConfig({
  host: Config.String("DATABRICKS_HOST"),
  warehouseId: Config.String("DATABRICKS_WAREHOUSE_ID"),
  accessToken: Config.Redacted("DATABRICKS_TOKEN").pipe(
    Config.map(Effect.succeed),
  ),
});

const { total } = await Effect.runPromise(
  countRows("samples.nyctaxi.trips").pipe(Effect.provide(Warehouse)),
);
console.log(total);
```

Use a table your identity can read. Use `DatabricksClient.layer` when you already have resolved configuration values. For OAuth, create one `Credentials.clientCredentials(...)` provider per identity and pass it as `accessToken`. To reuse your Effect HTTP middleware for warehouse requests, pass its client as `workspaceHttpClient`. Configure it to send each submission once. Signed storage downloads use a separate fetch client.

## Choose a result format

Ordinary `SqlClient` statements request `INLINE` with `JSON_ARRAY`. Databricks
returns each cell as a string or `null`, including numeric and boolean columns.
Decode values at the query boundary when the application needs another type.

| Call                                              | Result                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `yield* statement` or `yield* statement.raw`      | Array of rows keyed by column name.                                           |
| `statement.stream` or `sql.jsonStream(statement)` | The same rows streamed as workspace chunks arrive.                            |
| `yield* statement.values`                         | Arrays of cells in SQL select-list order. Duplicate column names are allowed. |
| `yield* sql.arrow(statement)`                     | Typed Arrow table downloaded using external links.                            |
| `sql.arrowStream(statement)`                      | Stream of typed Arrow record batches downloaded using external links.         |

Inline JSON suits small, predictable results. Databricks aborts a statement if its
inline result exceeds 25 MiB. A SQL row limit bounds the count, while row width
determines how many bytes the result uses. Use unique column names or aliases
for named rows. For larger results, select an Arrow method on the same client.
[Databricks Statement Execution API](https://docs.databricks.com/api/statement-execution/v1/execute-statement)

## Read inline JSON pages

Use `sql.jsonPage(statement, { rowLimit })` to submit a bounded query once. The
result contains the first chunk as named `rows` with string or null values,
`pageCount`, and a `truncated` flag. An empty result can have zero chunks.

```ts
const statement = sql`SELECT id FROM trips ORDER BY id`;
const firstPage = sql.jsonPage(statement, { rowLimit: 10_000 });
```

To read another chunk, call `page.readChunk(index, offset)` with an index from
1 through `page.pageCount - 1` and the number of rows received so far. The reader
validates that chunk against the original manifest and the supplied offset.
The first page accepts truncation when the reported row count reaches `rowLimit`.

## Arrow and Spark SQL

- Use `sql.arrow(statement)` for a table or `sql.arrowStream(statement)` for record batches. The adapter buffers one result chunk at a time when streaming. Each element of `sql.ipcStream(statement, { maxBytes })` is an independent IPC stream. Wrap downstream processing in `sql.withQueryTimeout` to include it in the deadline.
- Bind values with template substitutions. For an explicit type, use `sql.param("DATE", "2026-11-19")`, including inside `sql.in([...])`.
- Execute independent statements. Sessions, reserved connections, and transactions are unsupported. For bulk updates, `sql.updateValues` is unsupported. Write Spark SQL such as `UPDATE orders SET status = ${status} WHERE id = ${id}` inside the SQL template. Use `onDialectOrElse` to select Spark's fallback branch.
- A lost submission response can leave a write committed. Check the warehouse outcome before resubmitting. Ambiguous timeouts are non-retryable `SqlError`s. `error.reason.operation` identifies the phase, `error.reason.cause.reason` holds `"StatementTimeoutError"`, and `error.reason.cause.statementId` holds the ID when available.
