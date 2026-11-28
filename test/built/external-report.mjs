import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import * as Statement from "effect/sql/Statement";
import { inertHtml } from "foldkit/html";
import { expect, given, role, scene, text, textContent } from "foldkit/scene";
import { dataset } from "@dsiem/analytics";
import { makeAnalysisJob } from "@dsiem/analytics/jobs";
import { makeSavedViewStore } from "@dsiem/analytics/saved-views";
import { makeRecordComments } from "@dsiem/analytics/record-comments";
import { makeRecordPreview } from "@dsiem/analytics/record-preview";
import { h3Cells } from "@dsiem/analytics/spark";
import { metricGrid, recordTable } from "@dsiem/workbench-ui";
import { field, filterPanel } from "@dsiem/workbench-ui/filters";
import { createRecordExplorer } from "@dsiem/workbench-ui/record-explorer";
import { makeFindingsFeature } from "@dsiem/workbench-ui/findings";
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
  const Stock = Schema.Struct({
    category: Schema.String,
    remaining: Schema.Int,
  });
  const columns = [{ header: "Category", cell: (row) => row.category }];
  const key = (row) => row.category;
  const table = recordTable(inertHtml, [row], {
    caption: "Stock",
    key,
    columns,
  });
  assert.equal(textContent(table), "StockCategorybulk");

  scene(
    {
      update: (model) => ({ model }),
      view: (model, h) =>
        filterPanel(h, {
          label: "Stock filters",
          fields: [
            field(h, {
              id: "category",
              label: "Category",
              value: model.category,
              onInput: (category) => ({ category }),
            }),
          ],
          hasChanges: true,
          onApply: { apply: true },
        }),
    },
    given(row),
    expect(role("status")).toHaveText("Unapplied changes"),
  );

  const explorer = createRecordExplorer({
    row: Stock,
    detail: Stock,
    sorts: ["category"],
    key,
    columns,
    caption: "Stock on hand",
    inspector: (h, item) => [h.p([], [String(item.remaining)])],
    load: () => Effect.succeed([row]),
    inspect: (item) => Effect.succeed(item),
  });
  const stockList = explorer.init();
  const stocked = explorer.update(
    stockList.model,
    await Effect.runPromise(stockList.commands[0].effect),
  );
  scene(
    explorer,
    given(stocked.model),
    expect(role("button", { name: "Inspect bulk" })).toExist(),
  );

  const findings = makeFindingsFeature({
    filters: Schema.String,
    newFilters: Effect.succeed("bulk"),
    list: () => Effect.succeed({ rows: [], nextCursor: null }),
    save: () => Effect.die("Unexpected write"),
    pin: () => Effect.die("Unexpected pin"),
    remove: () => Effect.die("Unexpected delete"),
    describe: (category) => category,
    href: (category) => "/stock?category=" + encodeURIComponent(category),
  });
  const search = findings.init();
  const found = findings.update(
    search.model,
    await Effect.runPromise(search.commands[0].effect),
  );
  scene(
    findings,
    given(found.model),
    expect(text("No findings match this view.")).toExist(),
  );
  const css = await readFile(
    new URL(import.meta.resolve("@dsiem/workbench-ui/styles.css")),
    "utf8",
  );
  assert.match(css, /\.metric-grid|\.metrics/);
  assert.equal(typeof mountQueryPage, "function");
  assert.equal(typeof makeAnalysisJob, "function");
  assert.equal(typeof makeSavedViewStore, "function");
  assert.equal(typeof makeRecordComments, "function");
  assert.equal(typeof makeRecordPreview, "function");
  assert.equal(typeof h3Cells, "function");
  process.stdout.write(JSON.stringify(row));
} finally {
  db.close();
}
