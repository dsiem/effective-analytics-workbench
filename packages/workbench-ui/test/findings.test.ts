import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit, Fiber, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { AsyncData } from "foldkit";
import {
  type FindingOperations,
  makeFindingsFeature,
} from "../src/findings.js";

const filters = Schema.Struct({ station: Schema.String });
const row = (title: string) => ({
  id: "00000000-0000-4000-8000-000000000001",
  title,
  body: "Original notes",
  filters: { station: "Ridge" },
  version: 7,
  pinned: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});
const fixture = {
  filters,
  newFilters: Effect.succeed({ station: "Ridge" }),
  save: () => Effect.die("unused"),
  pin: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
  describe: (scope: typeof filters.Type) => scope.station,
  href: (scope: typeof filters.Type) => "/?station=" + scope.station,
};

type Feature = ReturnType<typeof makeFindingsFeature<typeof filters.Type>>;
type Transition = ReturnType<Feature["update"]>;
function command(transition: Transition) {
  const next = transition.commands?.[0];
  assert.ok(next);
  return next.effect;
}

test("replacing a debounced search does not interrupt another embedded instance", async () => {
  const queries: string[] = [];
  const list: FindingOperations<typeof filters.Type>["list"] = ({ q }) =>
    Effect.sync(() => {
      queries.push(q ?? "initial");
      return { rows: q ? [row(q)] : [], nextCursor: null };
    });
  const feature = makeFindingsFeature({ ...fixture, list });
  await Effect.runPromise(
    Effect.gen(function* () {
      const initial = feature.init();
      const firstReady = feature.update(initial.model, yield* command(initial));
      const otherInitial = feature.init();
      const secondReady = feature.update(
        otherInitial.model,
        yield* command(otherInitial),
      );
      const old = feature.update(
        firstReady.model,
        feature.Message.Search({ value: "old" }),
      );
      const other = feature.update(
        secondReady.model,
        feature.Message.Search({ value: "other" }),
      );
      const obsolete = yield* command(old).pipe(Effect.forkChild);
      const independent = yield* command(other).pipe(Effect.forkChild);
      yield* TestClock.adjust("100 millis");
      const replacing = feature.update(
        old.model,
        feature.Message.Search({ value: "latest" }),
      );
      const replacement = feature.update(
        replacing.model,
        yield* command(replacing),
      );
      assert.ok(Exit.isFailure(yield* Fiber.await(obsolete)));
      const latest = yield* command(replacement).pipe(Effect.forkChild);
      yield* TestClock.adjust("79 millis");
      assert.deepEqual(queries, ["initial", "initial"]);
      yield* TestClock.adjust("1 milli");
      const otherResult = feature.update(
        other.model,
        yield* Fiber.join(independent),
      );
      assert.deepEqual(queries, ["initial", "initial", "other"]);
      yield* TestClock.adjust("100 millis");
      const result = feature.update(
        replacement.model,
        yield* Fiber.join(latest),
      );
      const stale = feature.update(
        result.model,
        feature.Message.ListFailed({
          generation: old.model.search.generation,
          error: "Old search failure",
        }),
      );
      assert.equal(stale.model.search.data, result.model.search.data);
      assert.ok(AsyncData.isSuccess(result.model.search.data));
      assert.ok(AsyncData.isSuccess(otherResult.model.search.data));
      assert.deepEqual(
        result.model.search.data.data.rows.map(({ title }) => title),
        ["latest"],
      );
      assert.deepEqual(
        otherResult.model.search.data.data.rows.map(({ title }) => title),
        ["other"],
      );
      assert.deepEqual(queries, ["initial", "initial", "other", "latest"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("a conflict preserves the draft and saving a copy starts a new version history", async () => {
  const attempts: { id: string; title: string; version: number | null }[] = [];
  const feature = makeFindingsFeature({
    ...fixture,
    list: () =>
      Effect.succeed({ rows: [row("Current finding")], nextCursor: null }),
    save: ({ id, title, version }) =>
      Effect.suspend(() => {
        attempts.push({ id, title, version });
        return version === null
          ? Effect.succeed({ ...row(title), id, version: 1 })
          : Effect.fail("Finding changed");
      }),
  });
  const initial = feature.init();
  const loaded = feature.update(
    initial.model,
    await Effect.runPromise(command(initial)),
  );
  const selected = row("Current finding");
  const edited = feature.update(
    loaded.model,
    feature.Message.Edit({ row: selected }),
  );
  const changed = feature.update(
    edited.model,
    feature.Message.Change({ field: "title", value: " Revised finding " }),
  );
  const pending = feature.update(changed.model, feature.Message.Save());
  const conflicted = feature.update(
    pending.model,
    await Effect.runPromise(command(pending)),
  );
  assert.equal(conflicted.model.writes.panel._tag, "Editor");
  assert.equal(
    conflicted.model.writes.panel.editor.draft.title,
    " Revised finding ",
  );
  assert.equal(conflicted.model.writes.panel.editor.error, "Finding changed");
  const copying = feature.update(conflicted.model, feature.Message.Copy());
  const copied = feature.update(
    copying.model,
    await Effect.runPromise(command(copying)),
  );
  const saving = feature.update(copied.model, feature.Message.Save());
  const saved = feature.update(
    saving.model,
    await Effect.runPromise(command(saving)),
  );
  assert.equal(saved.model.writes.panel._tag, "Browse");
  assert.equal(saved.model.notice, "Finding saved.");
  const [update, insert] = attempts;
  assert.deepEqual(update, {
    id: selected.id,
    title: "Revised finding",
    version: 7,
  });
  assert.ok(insert);
  assert.equal(insert.title, "Revised finding");
  assert.equal(insert.version, null);
  assert.notEqual(insert.id, selected.id);
});
