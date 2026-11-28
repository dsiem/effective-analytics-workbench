import { CursorPage } from "@dsiem/analytics/contracts";
import { mountRunPage } from "@dsiem/workbench-ui/run-page";
import { Effect, Schema } from "effect";

const Stock = Schema.Struct({ category: Schema.String, units: Schema.Number });
const attempted = new Set<string>();
mountRunPage({
  container: document.getElementById("app"),
  draft: Schema.String,
  initial: "",
  run: Schema.String,
  report: CursorPage(Stock, Schema.String),
  list: Effect.succeed(["Warehouse stock"]),
  selection: Effect.succeed({
    run: "Warehouse stock",
    report: { rows: [{ category: "bulk", units: 20 }], nextCursor: null },
  }),
  submit: (draft, id) => {
    if (!attempted.has(draft)) {
      attempted.add(draft);
      return Effect.fail(`Request ${id} failed`);
    }
    return Effect.succeed(`#${encodeURIComponent(draft)}/${id}`);
  },
  heading: (h) => [h.h1([], ["Inventory analysis"])],
  form: (h, draft, changed, busy) => [
    h.label(
      [],
      [
        "Category",
        h.input([h.Value(draft), h.OnInput(changed), h.Disabled(busy)]),
      ],
    ),
  ],
  historyEntry: (run) => ({ href: "#stock", label: run, detail: "Inventory" }),
  result: (h, run, report) =>
    report.rows.map((row) =>
      h.p([], [`${run}: ${row.units} units (${row.category})`]),
    ),
});
