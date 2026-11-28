import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisQuestion, recentRowsSnapshot } from "../src/index.js";

test("a stock report question includes its own filter semantics and the visible bins", () => {
  const filters = { warehouse: "West", minUnits: 10 };
  const context = { page: "stock", bins: ["A1", "B2"] };
  const dataset = {
    table: "inventory.stock",
    filterInstructions:
      "Restrict warehouse by name and units by inclusive minimum.",
  };
  const prompt = analysisQuestion(dataset, {
    content: "Which bin needs a restock?",
    filters,
    context,
  });
  assert.ok(prompt.includes(dataset.table));
  assert.ok(prompt.includes(dataset.filterInstructions));
  assert.ok(prompt.includes(JSON.stringify(filters)));
  assert.ok(prompt.includes(JSON.stringify(context)));
  const reset = analysisQuestion(dataset, { content: "Check all inventory." });
  assert.ok(reset.includes("\n{}\n"));
  assert.ok(!reset.includes('"stock"'));
});

test("a stock snapshot spends the exact JSON budget on the newest bins", () => {
  const options = {
    fields: { inventory: "North" },
    rowsKey: "bins",
    rows: ['A"1', "B\\2", "C3"],
  };
  const available = (bins: string[]) =>
    JSON.stringify({ inventory: "North", bins });
  for (let count = 0; count <= options.rows.length; count++) {
    const expected = available(options.rows.slice(options.rows.length - count));
    const limit = expected.length;
    assert.equal(
      recentRowsSnapshot({ ...options, maxLength: limit }),
      expected,
    );
    const shorter = recentRowsSnapshot({ ...options, maxLength: limit - 1 });
    assert.equal(
      shorter,
      count === 0
        ? undefined
        : available(options.rows.slice(options.rows.length - count + 1)),
    );
  }
});
