import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import * as Statement from "effect/sql/Statement";
import { dataset } from "../src/index.js";

const sql = Statement.make(
  Effect.die("Queries run against the test database"),
  Statement.makeCompilerSqlite(),
  [],
  undefined,
);
const repairs = dataset(sql, {
  table: sql("work orders"),
  predicates: (filters: {
    readonly site?: string;
    readonly minHours?: number;
  }) => [
    filters.site !== undefined && sql`site = ${filters.site}`,
    filters.minHours !== undefined && sql`hours >= ${filters.minHours}`,
  ],
});
const params = Schema.decodeUnknownSync(
  Schema.Array(Schema.Union([Schema.String, Schema.Number])),
);

test("a filtered repair dataset supports backlog triage and labor totals", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE "work orders" (id INTEGER, site TEXT, trade TEXT, hours INTEGER, done INTEGER);
    INSERT INTO "work orders" VALUES
      (1, 'North', 'HVAC', 6, 0), (2, 'North', 'HVAC', 2, 1),
      (3, 'North', 'Power', 3, 0), (4, 'South', 'Power', 8, 0);
  `);
  const run = (statement: Statement.Statement<unknown>) => {
    const [query, binds] = statement.compile();
    return db
      .prepare(query)
      .all(...params(binds))
      .map((row) => ({ ...row }));
  };
  const fields = { id: sql("id"), "hours remaining": sql("hours") };
  const filters = { site: "North", minHours: 0 };
  assert.deepEqual(
    run(
      repairs.records({
        fields,
        filters,
        where: sql`done = 0`,
        orderBy: [sql`hours DESC`],
        limit: 1,
      }),
    ),
    [{ id: 1, "hours remaining": 6 }],
  );
  assert.deepEqual(
    run(
      repairs.records({
        fields: { id: sql("id") },
        filters: { site: "North" },
        where: sql`done = 1 OR hours >= 8`,
      }),
    ),
    [{ id: 2 }],
  );
  assert.deepEqual(
    run(
      repairs.aggregate({
        filters,
        dimensions: { department: sql("trade") },
        measures: { completed: sql`sum(done)`, labor: sql`sum(hours)` },
        orderBy: [sql`labor DESC`],
      }),
    ),
    [
      { department: "HVAC", completed: 1, labor: 8 },
      { department: "Power", completed: 0, labor: 3 },
    ],
  );
  assert.deepEqual(
    run(
      repairs.aggregate({
        filters: {},
        measures: { labor: sql`sum(hours)` },
      }),
    ),
    [{ labor: 19 }],
  );
  assert.deepEqual(
    run(repairs.records({ fields, filters: { site: "North' OR 1=1 --" } })),
    [],
  );
});

test("query definitions reject empty projections, duplicate aliases and invalid limits", () => {
  const filters = {};
  assert.throws(() => repairs.records({ filters, fields: {} }), /field/);
  assert.throws(() => repairs.aggregate({ filters, measures: {} }), /measure/);
  assert.throws(
    () =>
      repairs.aggregate({
        filters,
        dimensions: { trade: sql("trade") },
        measures: { trade: sql`count(*)` },
      }),
    /distinct/,
  );
  assert.throws(
    () => repairs.records({ filters, fields: { id: sql("id") }, limit: -1 }),
    /limit/,
  );
});
