import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Schema } from "effect";
import { expect, given, Mount, role, scene } from "foldkit/scene";
import {
  createRecordExplorer,
  recordViewportMount,
} from "../src/record-explorer.js";

test("inspecting another repair keeps each draft and ignores late details from the previous selection", async () => {
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
    inspect: (row) =>
      Effect.succeed({ technician: row.ticket === a.ticket ? "Avery" : "Sam" }),
  });
  const M = feature.Message;
  const started = feature.init();
  let model: typeof feature.Model.Type = started.model;
  const send = (message: typeof M.Type) => {
    const changed = feature.update(model, message);
    model = changed.model;
    return changed;
  };
  const first = send(M.Inspect({ row: a }));
  const listed = await Effect.runPromise(started.commands[0]!.effect);
  send(listed);
  assert.deepEqual(model.preview, {
    _tag: "Ready",
    rows: [a, b],
    hasMore: false,
  });
  send(M.Edit({ body: "Adjust valve" }));
  const second = send(M.Inspect({ row: b }));
  send(await Effect.runPromise(first.commands![0]!.effect));
  assert.equal(Option.getOrThrow(model.inspector).details._tag, "Loading");
  send(await Effect.runPromise(second.commands![0]!.effect));
  assert.deepEqual(Option.getOrThrow(model.inspector).details, {
    _tag: "Success",
    data: { technician: "Sam" },
  });
  send(M.Close());
  send(M.Sort({ sort: "oldest" }));
  send(listed);
  assert.equal(model.preview._tag, "Loading");
  send(M.Inspect({ row: a }));
  assert.equal(model.commentDrafts[a.ticket]?.body, "Adjust valve");
});

test("the embedded explorer retries the original comment after reopening a refreshed record", async () => {
  const Row = Schema.Struct({ ticket: Schema.String, revision: Schema.Int });
  const original = { ticket: "R41", revision: 1 };
  const attempts: { row: typeof Row.Type; id: string; body: string }[] = [];
  const feature = createRecordExplorer({
    row: Row,
    detail: Row,
    sort: Schema.Literal("newest"),
    sorts: ["newest"],
    sortLabel: (sort) => sort,
    key: (row) => row.ticket,
    caption: "Repairs",
    columns: [{ header: "Ticket", cell: (row) => row.ticket }],
    heading: () => [],
    inspector: () => [],
    inspectLabel: (row) => row.ticket,
    load: () => Effect.succeed([original]),
    inspect: Effect.succeed,
    comments: {
      list: () => Effect.succeed({ rows: [], nextCursor: null }),
      post: (row, id, body) =>
        Effect.suspend(() => {
          attempts.push({ row, id, body });
          return attempts.length === 1
            ? Effect.fail("Response lost")
            : Effect.succeed({
                id,
                body,
                author: null,
                created_at: "2026-11-28T10:00:00Z",
              });
        }),
    },
  });
  const { Message: M } = feature;
  let model = feature.init().model;
  const send = (message: typeof M.Type) => {
    const changed = feature.update(model, message);
    model = changed.model;
    return changed.commands ?? [];
  };
  const post = async () => {
    const command = send(M.Post()).find(
      (command) => command.name === "PostComment",
    );
    assert.ok(command);
    send(await Effect.runPromise(command.effect));
  };
  send(M.Inspect({ row: original }));
  send(M.Edit({ body: "Investigate the pump" }));
  await post();
  assert.equal(Option.getOrThrow(model.postError), "Response lost");
  send(M.Close());
  send(M.Inspect({ row: { ...original, revision: 2 } }));
  await post();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(attempts[1]?.row, original);
  assert.equal(model.commentDrafts[original.ticket], undefined);
  const thread = Option.getOrThrow(
    Option.getOrThrow(model.inspector).comments.data,
  );
  assert.deepEqual(
    thread.rows.map((note) => note.body),
    ["Investigate the pump"],
  );
});

test("arbitrary rows stay accessible and fixed-height lists render the scrolled window", async () => {
  const row = Schema.Struct({ id: Schema.String });
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
  const options = {
    row,
    detail: row,
    sorts: ["id"] as const,
    key: (record: typeof row.Type) => record.id,
    caption: "Tickets",
    columns: [{ header: "ID", cell: (record: typeof row.Type) => record.id }],
    inspector: () => [],
    load: () => Effect.succeed(rows),
    inspect: (record: typeof row.Type) => Effect.succeed(record),
  };
  const inspect = (id: number) => role("button", { name: `Inspect ${id}` });
  for (const sizing of [{}, { fixedRowHeight: 48 }]) {
    const explorer = createRecordExplorer({ ...options, ...sizing });
    const loading = explorer.init();
    const command = loading.commands[0];
    assert.ok(command);
    const { model } = explorer.update(
      loading.model,
      await Effect.runPromise(command.effect),
    );
    if (sizing.fixedRowHeight === undefined) {
      scene(
        explorer,
        given(model),
        expect(inspect(0)).toExist(),
        expect(inspect(99)).toExist(),
        Mount.expectNone(),
      );
      continue;
    }
    const generation = model.loadGeneration;
    const viewport = {
      firstRow: 70,
      visibleEnd: 80,
      tabStart: 70,
      tabEnd: 80,
      rowHeight: 48,
    };
    scene(
      explorer,
      given(model),
      expect(inspect(0)).toExist(),
      expect(inspect(99)).toBeAbsent(),
      Mount.resolve(
        recordViewportMount(
          generation,
          explorer.Message.Scrolled,
          sizing.fixedRowHeight,
        ),
        explorer.Message.Scrolled({ generation, viewport }),
      ),
      expect(inspect(75)).toExist(),
      expect(inspect(0)).toBeAbsent(),
    );
  }
});
