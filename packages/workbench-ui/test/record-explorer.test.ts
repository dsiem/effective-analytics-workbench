import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { createRecordExplorer } from "../src/record-explorer.js";

test("inspecting another repair keeps each draft and ignores late details from the previous selection", () => {
  const Repair = Schema.Struct({ ticket: Schema.String, priority: Schema.Int });
  const Detail = Schema.Struct({ technician: Schema.String });
  const a = { ticket: "A17", priority: 5 },
    b = { ticket: "B10", priority: 7 };
  const feature = createRecordExplorer({
    row: Repair,
    detail: Detail,
    sort: Schema.Literals(["urgent", "oldest"]),
    sorts: ["urgent", "oldest"] as const,
    sortLabel: (key) => key,
    key: (row) => row.ticket,
    caption: "Repairs",
    columns: [{ header: "Ticket", value: (row) => row.ticket }],
    heading: () => [],
    inspector: (h, row) => [h.p([], [row.technician])],
    inspectLabel: (row) => row.ticket,
    load: () => Effect.succeed([a, b]),
    inspect: () => Effect.die("Unused"),
  });
  const M = feature.Message;
  let model: typeof feature.Model.Type = feature.init().model;
  const send = (message: typeof M.Type) => {
    model = feature.update(model, message).model;
  };
  send(M.Inspect({ row: a }));
  const previous = model.revision;
  send(M.Edit({ body: "Adjust valve" }));
  send(M.Inspect({ row: b }));
  send(M.Inspected({ revision: previous, detail: { technician: "Avery" } }));
  assert.equal(model.detail._tag, "Loading");
  send(
    M.Inspected({ revision: model.revision, detail: { technician: "Sam" } }),
  );
  assert.deepEqual(model.detail, {
    _tag: "Success",
    data: { technician: "Sam" },
  });
  send(M.Close());
  send(M.Sort({ sort: "oldest" }));
  send(M.Listed({ revision: previous, rows: [b] }));
  assert.equal(model.rows._tag, "Loading");
  send(M.Inspect({ row: a }));
  assert.equal(model.drafts[a.ticket]?.body, "Adjust valve");
});
