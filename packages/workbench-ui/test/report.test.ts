import assert from "node:assert/strict";
import { test } from "node:test";
import { inertHtml, type Html } from "foldkit/html";
import { metricGrid, recordTable, seriesChart } from "../src/index.js";

function contents(node: Html | string | undefined): string {
  if (typeof node === "string") return node;
  return node?.text ?? node?.children?.map(contents).join("") ?? "";
}

function matching(node: Html | string | undefined, tag: string): string[] {
  if (!node || typeof node === "string") return [];
  if (node.sel === tag) return [contents(node)];
  return node.children?.flatMap((child) => matching(child, tag)) ?? [];
}

test("a station report uses the same readings for a temperature chart and a threshold table", () => {
  const readings = [
    { sensor: "Ridge", celsius: -2.5 },
    { sensor: "Valley", celsius: 3.1 },
  ];
  const degrees = (value: number) => `${value.toFixed(1)} °C`;
  const grid = metricGrid(inertHtml, { low: -2.5, stations: 2 }, [
    {
      label: "Minimum temperature",
      value: ({ low }) => degrees(low),
      detail: ({ stations }) => `Across ${stations} stations`,
    },
  ]);
  assert.deepEqual(matching(grid, "h2"), ["Minimum temperature"]);
  assert.deepEqual(matching(grid, "p"), ["-2.5 °C", "Across 2 stations"]);

  const chart = seriesChart(inertHtml, readings, {
    title: "Temperature by station",
    kind: "bar",
    label: (row) => row.sensor,
    value: (row) => row.celsius,
    formatValue: degrees,
  });
  assert.deepEqual(matching(chart, "title"), [
    "Temperature by station",
    "Ridge: -2.5 °C",
    "Valley: 3.1 °C",
  ]);

  const table = recordTable(inertHtml, readings, {
    caption: "Freeze risk",
    key: (row) => row.sensor,
    columns: [
      { header: "Station", cell: (row) => row.sensor },
      {
        header: "Status",
        cell: (row) => (row.celsius <= 0 ? "Freezing" : "Clear"),
      },
    ],
  });
  assert.deepEqual(matching(table, "caption"), ["Freeze risk"]);
  assert.deepEqual(matching(table, "th"), ["Station", "Status"]);
  assert.deepEqual(matching(table, "td"), [
    "Ridge",
    "Freezing",
    "Valley",
    "Clear",
  ]);
});
