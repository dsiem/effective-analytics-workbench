import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import * as Statement from "effect/sql/Statement";
import { inertHtml } from "foldkit/html";
import { dataset } from "@dsiem/analytics";
import { bindJob } from "@dsiem/analytics/jobs";
import { makeSavedViewStore } from "@dsiem/analytics/saved-views";
import { makeRecordComments } from "@dsiem/analytics/record-comments";
import { makeRecordPreview } from "@dsiem/analytics/record-preview";
import { h3Cells } from "@dsiem/analytics/spark";
import { metricGrid } from "@dsiem/workbench-ui";
import { mountQueryPage } from "@dsiem/workbench-ui/query-page";

const sql = Statement.make(
  Effect.die("SQLite executes the compiled statement"),
  Statement.makeCompilerSqlite(),
  [],
  undefined,
);
const stock = dataset(sql, {
  table: sql("stock"),
  predicates: ({ category }) => [sql`category = ${category}`],
});
const [query, bindings] = stock
  .aggregate({
    filters: { category: "bulk" },
    dimensions: { category: sql("category") },
    measures: { remaining: sql`sum(units)` },
  })
  .compile();
const db = new DatabaseSync(":memory:");
try {
  db.exec(
    "CREATE TABLE stock(category TEXT, units INT); INSERT INTO stock VALUES ('bulk', 12), ('bulk', 8), ('boxed', 99)",
  );
  const row = db.prepare(query).get(...bindings);
  const metrics = metricGrid(inertHtml, row, [
    {
      label: "Remaining",
      value: ({ remaining }) => String(remaining),
      detail: "Units",
    },
  ]);
  assert.equal(metrics.children.length, 1);
  const css = await readFile(
    new URL(import.meta.resolve("@dsiem/workbench-ui/styles.css")),
    "utf8",
  );
  assert.match(css, /\.metric-grid|\.metrics/);
  assert.equal(typeof mountQueryPage, "function");
  assert.equal(typeof bindJob, "function");
  assert.equal(typeof makeSavedViewStore, "function");
  assert.equal(typeof makeRecordComments, "function");
  assert.equal(typeof makeRecordPreview, "function");
  assert.equal(typeof h3Cells, "function");
  process.stdout.write(JSON.stringify(row));
} finally {
  db.close();
}
