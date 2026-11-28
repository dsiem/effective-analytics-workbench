import assert from "node:assert/strict";
import { test } from "node:test";
import type { Html } from "foldkit/html";
import { inertHtml } from "foldkit/html";
import { chart } from "../src/index.js";

function elements(html: Html | string | undefined): NonNullable<Html>[] {
  return html && typeof html !== "string"
    ? [html, ...(html.children?.flatMap(elements) ?? [])]
    : [];
}

function text(html: Html | string | undefined): string {
  if (typeof html === "string") return html;
  return html?.text ?? html?.children?.map(text).join("") ?? "";
}

test("chart axes use readable intervals rather than fractional trip counts", () => {
  const rendered = chart(inertHtml, {
    title: "Trip counts",
    kind: "area",
    data: [{ label: "Monday", value: 3351 }],
    formatTick: String,
  });
  const labels = elements(rendered)
    .filter((node) => node.sel === "text")
    .map(text);
  assert.deepEqual(labels, ["0", "1000", "2000", "3000", "4000", "Monday"]);
});

for (const values of [[-10, 0, 20], [-10, -5], [0, 0], [0.05, 0.1], [3]]) {
  test(`chart bars stay within the plot for ${JSON.stringify(values)}`, () => {
    const rendered = chart(inertHtml, {
      title: "Metric",
      kind: "bar",
      data: values.map((value) => ({ label: String(value), value })),
    });
    const bars = elements(rendered).filter((element) => element.sel === "rect");
    assert.equal(bars.length, values.length);
    for (const bar of bars) {
      const x = Number(bar.data?.attrs?.x);
      const y = Number(bar.data?.attrs?.y);
      const width = Number(bar.data?.attrs?.width);
      const height = Number(bar.data?.attrs?.height);
      assert.ok(width > 0 && height >= 0, "SVG dimensions must be valid");
      assert.ok(x >= 0 && x + width <= 700, "bars fit horizontally");
      assert.ok(y >= 0 && y + height <= 260, "bars fit vertically");
    }
  });
}

test("chart bars extend above and below the same zero baseline", () => {
  const rendered = chart(inertHtml, {
    title: "Net change",
    kind: "bar",
    data: [-10, 0, 20].map((value) => ({ label: String(value), value })),
  });
  const [negative, zero, positive] = elements(rendered).filter(
    (element) => element.sel === "rect",
  );
  const baseline = Number(zero?.data?.attrs?.y);
  assert.equal(Number(zero?.data?.attrs?.height), 0);
  assert.equal(Number(negative?.data?.attrs?.y), baseline);
  assert.ok(Number(positive?.data?.attrs?.y) < baseline);
  assert.equal(
    Number(positive?.data?.attrs?.y) + Number(positive?.data?.attrs?.height),
    baseline,
  );
});

test("chart points preserve currency precision and use the supplied tick formatter", () => {
  const rendered = chart(inertHtml, {
    title: "Revenue",
    kind: "area",
    data: [{ label: "Monday", value: 1.25 }],
    formatValue: (value) => `$${value.toFixed(2)}`,
    formatTick: (value) => `USD ${value}`,
  });
  assert.equal(rendered?.data?.attrs?.["aria-label"], "Revenue");
  const nodes = elements(rendered);
  assert.ok(
    nodes.some(
      (node) => node.sel === "title" && text(node) === "Monday: $1.25",
    ),
  );
  assert.ok(
    nodes.some((node) => node.sel === "text" && text(node) === "USD 0"),
  );
  assert.ok(
    nodes
      .filter((node) => node.sel === "text" && text(node) !== "Monday")
      .every((node) => text(node).startsWith("USD ")),
  );
});

test("empty and fractional charts have finite geometry and scale small values", () => {
  for (const values of [[], [0], [0.05, 0.1]]) {
    const rendered = chart(inertHtml, {
      title: "Metric",
      kind: "area",
      data: values.map((value) => ({ label: String(value), value })),
    });
    const nodes = elements(rendered);
    for (const node of nodes) {
      for (const [name, value] of Object.entries(node.data?.attrs ?? {})) {
        if (["x", "y", "x1", "y1", "x2", "y2", "cx", "cy"].includes(name))
          assert.ok(Number.isFinite(Number(value)), `${name} must be finite`);
      }
    }
    const points = nodes.filter((node) => node.sel === "circle");
    if (points.length === 2)
      assert.ok(
        Math.abs(
          Number(points[0]?.data?.attrs?.cy) -
            Number(points[1]?.data?.attrs?.cy),
        ) > 50,
      );
  }
});
