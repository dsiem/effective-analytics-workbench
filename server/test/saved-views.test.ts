import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PgClient } from "@effect/sql-pg";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Redacted,
  Stream,
} from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import {
  AuthorizationError,
  SqlError,
  UnknownError,
} from "effect/sql/SqlError";
import type {
  SavedView,
  SavedViewSearch,
} from "@dsiem/analytics-shared/saved-views";
import {
  type ServiceError,
  type WorkspaceRequestError,
  unavailable,
  UpstreamError,
} from "../src/errors.js";
import { Lakebase } from "../src/lakebase.js";
import { initializeAppSchema } from "../src/lakebase-schema.js";
import { pgPassword, restoreCredentialFailure } from "../src/pg-credentials.js";
import { SavedViews } from "../src/saved-views.js";
import { Settings } from "../src/settings.js";
import { Workspace } from "../src/workspace.js";
import { lakebaseFixture } from "./lakebase-fixture.js";

const input = {
  id: "1b7f2115-e891-46a7-a3ad-c26405b2f5a2",
  title: "A saved view",
  body: "",
  filters: {},
  version: null,
};
const operations: Record<
  string,
  (
    savedViews: typeof SavedViews.Service,
  ) => Effect.Effect<unknown, ServiceError>
> = {
  list: (savedViews: typeof SavedViews.Service) => savedViews.list({}),
  save: (savedViews: typeof SavedViews.Service) => savedViews.save(input),
  pin: (savedViews) => savedViews.pin(input.id, { version: 1, pinned: true }),
  remove: (savedViews: typeof SavedViews.Service) =>
    savedViews.remove(input.id, 1),
};
const runSavedViews = <A, E>(
  credentials: Effect.Effect<unknown, WorkspaceRequestError>,
  use: (savedViews: typeof SavedViews.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.flatMap(SavedViews, use).pipe(
      Effect.provide(
        SavedViews.layer.pipe(
          Layer.provide(Lakebase.layer),
          Layer.provide(
            Layer.succeed(Workspace, {
              requestEvents: () =>
                Effect.die("Unexpected workspace event request"),
              accessToken: Effect.succeed(Redacted.make("unused")),
              request: () => credentials,
            }),
          ),
          Layer.provide(Settings.layer),
        ),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          PGHOST: "unused.invalid",
          PGUSER: "test",
          LAKEBASE_ENDPOINT: "endpoint",
        }),
      ),
      Effect.scoped,
    ),
  );

for (const [name, operation] of Object.entries(operations)) {
  test(`saved views ${name} preserves credential diagnostics as a typed service failure`, async () => {
    const original = new Error("credential diagnostic");
    const upstream = new UpstreamError({
      service: "workspace",
      message: "Authentication failed",
      cause: original,
    });
    const exit = await runSavedViews(Effect.fail(upstream), operation);
    assert.ok(Exit.isFailure(exit));
    const error = Cause.findErrorOption(exit.cause);
    assert.equal(error._tag, "Some");
    if (error._tag === "Some") {
      assert.equal(error.value._tag, "ServiceUnavailable");
      assert.ok("cause" in error.value);
      assert.equal(error.value.cause, upstream);
    }
    assert.equal(Cause.hasDies(exit.cause), false);
  });

  test(`saved views ${name} preserves unexpected defects`, async () => {
    const defect = new Error("programming error");
    const exit = await runSavedViews(Effect.die(defect), operation);
    assert.ok(Exit.isFailure(exit));
    assert.ok(
      exit.cause.reasons.some(
        (reason) => Cause.isDieReason(reason) && reason.defect === defect,
      ),
    );
    assert.equal(Cause.hasFails(exit.cause), false);
  });

  test(`saved views ${name} preserves interruption`, async () => {
    const exit = await runSavedViews(Effect.interrupt, operation);
    assert.ok(Exit.isFailure(exit));
    assert.ok(Cause.hasInterruptsOnly(exit.cause));
  });
}

test("invalid Lakebase credential payload is a typed error with its schema diagnostic", async () => {
  const exit = await runSavedViews(
    Effect.succeed({ token: 42 }),
    (savedViews) => savedViews.list({}),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some");
  if (error._tag === "Some" && error.value._tag === "ServiceUnavailable") {
    assert.ok(error.value.cause && typeof error.value.cause === "object");
    assert.equal(Reflect.get(error.value.cause, "_tag"), "SchemaError");
  } else assert.fail("Expected a typed Lakebase failure");
});

const withRows = <A, E>(
  rows: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
  use: (savedViews: typeof SavedViews.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const connection: Connection = {
        execute: () => rows,
        executeUnprepared: () => rows,
        executeRaw: () => rows,
        executeStream: () => Stream.die("Unused stream"),
        executeValues: () => Effect.succeed([]),
        executeValuesUnprepared: () => Effect.succeed([]),
      };
      const sql = yield* SqlClient.make({
        driver: "pg",
        spanAttributes: [],
        compiler: PgClient.makeCompiler(),
        acquirer: Effect.succeed(connection),
      });
      return yield* Effect.flatMap(SavedViews, use).pipe(
        Effect.provide(SavedViews.layer),
        Effect.provideService(Lakebase, {
          use: (run) =>
            run(
              Object.assign(sql, {
                json: (value: unknown) => sql`${JSON.stringify(value)}`,
              }),
            ),
        }),
      );
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );

test("saved view writes report denied table access", async () => {
  const denied = new SqlError({
    reason: new AuthorizationError({ cause: undefined, operation: "query" }),
  });
  const result = await withRows(Effect.fail(denied), (views) =>
    views.pin(input.id, { version: 1, pinned: true }),
  );
  assert.ok(Exit.isFailure(result));
  const error = Cause.findErrorOption(result.cause);
  assert.ok(error._tag === "Some" && error.value._tag === "PermissionDenied");
  assert.match(error.value.message, /permission to save it/);
});

test("a denied Lakebase credential request stays a permission error", async () => {
  const denied = new UpstreamError({
    service: "workspace",
    upstreamStatus: 403,
    message: "internal diagnostic",
  });
  const exit = await runSavedViews(Effect.fail(denied), (views) =>
    views.list({}),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(error._tag === "Some" && error.value._tag === "PermissionDenied");
  assert.match(error.value.message, /access saved views and comments/);
});

test("saved views maps SQL failures without losing the original cause", async () => {
  const sqlError = new SqlError({
    reason: new UnknownError({
      cause: new Error("database diagnostic"),
      message: "Database failed",
      operation: "execute",
    }),
  });
  const exit = await withRows(Effect.fail(sqlError), (savedViews) =>
    savedViews.list({}),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(error._tag === "Some" && error.value._tag === "ServiceUnavailable");
  assert.equal(error.value.cause, sqlError);
});

test("saved views preserves row decoding diagnostics", async () => {
  const exit = await withRows(
    Effect.succeed([{ id: "invalid" }]),
    (savedViews) => savedViews.list({}),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(error._tag === "Some" && error.value._tag === "ServiceUnavailable");
  assert.equal(Reflect.get(error.value.cause as object, "_tag"), "SchemaError");
});

test("removing a missing saved view keeps its distinct not-found error", async () => {
  const exit = await withRows(Effect.succeed([]), (savedViews) =>
    savedViews.remove(input.id, 1),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(error._tag === "Some" && error.value._tag === "SavedViewNotFound");
  assert.equal(error.value.id, input.id);
});

test("the credential adapter preserves every reason in a mixed cause", async () => {
  const credentialError = unavailable("lakebase", "Credential failure");
  const bridged = await Effect.runPromiseExit(
    pgPassword(Effect.fail(credentialError)),
  );
  assert.ok(Exit.isFailure(bridged));
  const defect = new Error("unexpected defect");
  const compound = Cause.combine(
    bridged.cause,
    Cause.combine(Cause.die(defect), Cause.interrupt(42)),
  );
  const exit = await Effect.runPromiseExit(
    restoreCredentialFailure(Effect.failCause(compound)),
  );
  assert.ok(Exit.isFailure(exit));
  assert.equal(exit.cause.reasons.length, 3);
  assert.ok(
    exit.cause.reasons.some(
      (reason) =>
        Cause.isFailReason(reason) && reason.error === credentialError,
    ),
  );
  assert.ok(
    exit.cause.reasons.some(
      (reason) => Cause.isDieReason(reason) && reason.defect === defect,
    ),
  );
  assert.deepEqual(Cause.interruptors(exit.cause), new Set([42]));
});

test("versioned saved-view writes replay matching operations and reject competing writes and deleted-view resurrection", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { savedViews, sql } = yield* lakebaseFixture;
      // Schema setup is repeatable and preserves existing rows.
      const created = yield* savedViews.save(input);
      assert.deepEqual(yield* savedViews.save(input), created);
      yield* initializeAppSchema(sql);
      yield* initializeAppSchema(sql);
      assert.deepEqual((yield* savedViews.list({})).rows, [created]);
      assert.equal(created.version, 1);
      assert.equal(created.pinned, false);
      const duplicate = yield* Effect.result(
        savedViews.save({ ...input, title: "Duplicate" }),
      );
      assert.ok(
        duplicate._tag === "Failure" &&
          duplicate.failure._tag === "SavedViewConflict",
      );

      const edits = yield* Effect.all(
        [
          savedViews
            .save({ ...created, title: "First editor" })
            .pipe(Effect.result),
          savedViews
            .save({ ...created, title: "Second editor" })
            .pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      const successes = edits.filter((edit) => edit._tag === "Success");
      assert.equal(successes.length, 1);
      const failure = edits.find((edit) => edit._tag === "Failure");
      assert.ok(
        failure?._tag === "Failure" &&
          failure.failure._tag === "SavedViewConflict",
      );
      const current = (yield* savedViews.list({})).rows[0];
      assert.ok(current);
      assert.equal(current.version, 2);
      assert.equal(current.title, successes[0]?.success.title);
      assert.deepEqual(
        yield* savedViews.save({ ...created, title: current.title }),
        current,
      );

      const stalePin = yield* Effect.result(
        savedViews.pin(created.id, { version: 1, pinned: true }),
      );
      assert.ok(
        stalePin._tag === "Failure" &&
          stalePin.failure._tag === "SavedViewConflict",
      );
      const pinned = yield* savedViews.pin(current.id, {
        version: current.version,
        pinned: true,
      });
      assert.equal(pinned.title, current.title);
      assert.equal(pinned.body, current.body);
      assert.deepEqual(pinned.filters, current.filters);
      assert.equal(pinned.pinned, true);
      assert.equal(pinned.version, 3);
      assert.deepEqual(
        yield* savedViews.pin(current.id, {
          version: current.version,
          pinned: true,
        }),
        pinned,
      );

      // Matching content cannot turn a pin into a replayed edit.
      const unchangedEdit = yield* Effect.result(savedViews.save(current));
      assert.ok(
        unchangedEdit._tag === "Failure" &&
          unchangedEdit.failure._tag === "SavedViewConflict",
      );

      const staleEdit = yield* Effect.result(
        savedViews.save({ ...current, body: "Stale draft" }),
      );
      assert.ok(
        staleEdit._tag === "Failure" &&
          staleEdit.failure._tag === "SavedViewConflict",
      );
      const staleDelete = yield* Effect.result(
        savedViews.remove(current.id, current.version),
      );
      assert.ok(
        staleDelete._tag === "Failure" &&
          staleDelete.failure._tag === "SavedViewConflict",
      );
      const updated = yield* savedViews.save({
        ...pinned,
        body: "Latest draft",
      });
      assert.equal(updated.pinned, true);
      yield* savedViews.remove(updated.id, updated.version);
      yield* savedViews.remove(updated.id, updated.version);
      for (const operation of [
        savedViews.save(input),
        savedViews.save({ ...updated, body: "Deleted draft" }),
        savedViews.pin(updated.id, { version: updated.version, pinned: false }),
        savedViews.remove(updated.id, current.version),
      ]) {
        const result = yield* Effect.result(operation);
        assert.ok(
          result._tag === "Failure" &&
            result.failure._tag === "SavedViewNotFound",
        );
      }
      assert.deepEqual(yield* savedViews.list({}), {
        rows: [],
        nextCursor: null,
      });
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});

test("saved views pages reach every saved view beyond 200, preserving pins, timestamp precision, and ties", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { savedViews, sql } = yield* lakebaseFixture;
      assert.deepEqual(yield* savedViews.list({}), {
        rows: [],
        nextCursor: null,
      });
      const inputs = Array.from({ length: 217 }, (_, index) => ({
        ...input,
        id: randomUUID(),
        title: String(index),
      }));
      yield* Effect.forEach(inputs, (savedView) => savedViews.save(savedView));
      yield* sql`UPDATE app.saved_views SET pinned = title::int < 26,
        updated_at = '2026-11-13T10:00:00Z'::timestamptz +
          (title::int % 3) * INTERVAL '1 microsecond'`;
      const expected = [...inputs].sort(
        (a, b) =>
          Number(Number(b.title) < 26) - Number(Number(a.title) < 26) ||
          (Number(b.title) % 3) - (Number(a.title) % 3) ||
          b.id.localeCompare(a.id),
      );
      const collected: SavedView[] = [];
      let search: SavedViewSearch = {};
      let pages = 0;
      while (true) {
        const page = yield* savedViews.list(search);
        pages++;
        assert.ok(pages <= 10, "continuation must advance");
        assert.ok(page.rows.length > 0 && page.rows.length <= 24);
        collected.push(...page.rows);
        if (!page.nextCursor) break;
        search = { cursor: page.nextCursor };
      }
      assert.equal(pages, 10);
      assert.deepEqual(
        collected.map((savedView) => savedView.id),
        expected.map((savedView) => savedView.id),
      );
      assert.equal(
        new Set(collected.map((savedView) => savedView.id)).size,
        217,
      );
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});

test("continuation survives deletion of the boundary saved view and ignores newer inserts", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { savedViews, sql } = yield* lakebaseFixture;
      for (let index = 0; index < 25; index++) {
        yield* savedViews.save({
          ...input,
          id: randomUUID(),
          title: String(index),
        });
      }
      yield* sql`UPDATE app.saved_views SET updated_at = '2026-11-13T10:00:00Z'::timestamptz
        + title::int * INTERVAL '1 second'`;
      const first = yield* savedViews.list({});
      assert.ok(first.nextCursor);
      const boundary = first.rows.at(-1);
      assert.ok(boundary);
      yield* savedViews.remove(boundary.id, boundary.version);
      assert.equal((yield* savedViews.list({})).nextCursor, null);
      const arrival = yield* savedViews.save({
        ...input,
        id: randomUUID(),
        title: "New arrival",
      });
      yield* sql`UPDATE app.saved_views SET updated_at = '2026-11-14T00:00:00Z'::timestamptz WHERE id = ${arrival.id}::uuid`;
      const last = yield* savedViews.list({ cursor: first.nextCursor });
      assert.deepEqual(
        last.rows.map((savedView) => savedView.title),
        ["0"],
      );
      assert.equal(last.nextCursor, null);
      assert.equal((yield* savedViews.list({})).rows[0]?.title, "New arrival");
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});

test("saved-view search finds older views across title, notes, dates and ZIP using every token", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { savedViews, sql } = yield* lakebaseFixture;
      const target = yield* savedViews.save({
        ...input,
        title: "Airport Focus",
        body: "Amber findings",
        filters: { from: "2016-01-03", to: "2016-02-27", zip: "10001" },
      });
      yield* sql`UPDATE app.saved_views SET updated_at = '2026-01-01T00:00:00Z'::timestamptz`;
      for (let index = 0; index < 30; index++) {
        yield* savedViews.save({
          ...input,
          id: randomUUID(),
          title: `Other ${index}`,
        });
      }
      assert.equal(
        (yield* savedViews.list({})).rows.some((row) => row.id === target.id),
        false,
      );
      for (const q of [
        "FOCUS",
        "amber",
        "2016-01-03",
        "2016-02-27",
        "10001",
        "  fOcUs\tAMBER\n2016-01 2016-02 10001  ",
      ]) {
        const page = yield* savedViews.list({ q });
        assert.deepEqual(
          page.rows.map((row) => row.id),
          [target.id],
          q,
        );
        assert.equal(page.nextCursor, null);
      }
      assert.deepEqual(
        (yield* savedViews.list({ q: "focus missing" })).rows,
        [],
      );
      assert.deepEqual(
        yield* savedViews.list({ q: " \t\n " }),
        yield* savedViews.list({}),
      );
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});

test("saved-view search treats wildcard characters and SQL text as literal substrings", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { savedViews } = yield* lakebaseFixture;
      const target = yield* savedViews.save({
        ...input,
        title: "100% target_rate \\vendor's",
      });
      yield* savedViews.save({
        ...input,
        id: randomUUID(),
        title: "100X targetXrate vendors",
      });
      for (const q of ["%", "_", "\\vendor", "vendor's", "100% target_rate"]) {
        assert.deepEqual(
          (yield* savedViews.list({ q })).rows.map((row) => row.id),
          [target.id],
          q,
        );
      }
      assert.deepEqual((yield* savedViews.list({ q: "' OR 1=1 --" })).rows, []);
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});

test("saved-view search paginates only matching rows while preserving pins and microsecond ties", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { savedViews, sql } = yield* lakebaseFixture;
      const inputs = Array.from({ length: 58 }, (_, index) => ({
        ...input,
        id: randomUUID(),
        title: String(index),
        body: index % 2 === 0 ? "Matching notes" : "Other notes",
      }));
      yield* Effect.forEach(inputs, (view) => savedViews.save(view));
      yield* sql`UPDATE app.saved_views SET pinned = title::int < 30,
        updated_at = '2026-11-13T10:00:00Z'::timestamptz +
          (title::int % 3) * INTERVAL '1 microsecond'`;
      const expected = inputs
        .filter((view) => view.body === "Matching notes")
        .sort(
          (a, b) =>
            Number(Number(b.title) < 30) - Number(Number(a.title) < 30) ||
            (Number(b.title) % 3) - (Number(a.title) % 3) ||
            b.id.localeCompare(a.id),
        );
      const first = yield* savedViews.list({ q: "MATCHING notes" });
      assert.equal(first.rows.length, 24);
      assert.ok(first.nextCursor);
      assert.match(first.nextCursor.updatedAt, /\.\d{6}Z$/);
      const second = yield* savedViews.list({
        q: "MATCHING notes",
        cursor: first.nextCursor,
      });
      assert.equal(second.rows.length, 5);
      assert.equal(second.nextCursor, null);
      assert.deepEqual(
        [...first.rows, ...second.rows].map((row) => row.id),
        expected.map((row) => row.id),
      );
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});

test("saved-view IDs hydrate current versions beyond the first page and compose with search and cursor", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { savedViews, sql } = yield* lakebaseFixture;
      const recent = yield* savedViews.save(input);
      const changed = yield* savedViews.save({
        ...recent,
        title: "Fresh title",
        body: "Updated notes",
      });
      const removed = yield* savedViews.save({ ...input, id: randomUUID() });
      yield* savedViews.remove(removed.id, removed.version);
      yield* sql`UPDATE app.saved_views SET updated_at = '2026-01-01T00:00:00Z'::timestamptz`;
      for (let index = 0; index < 30; index++) {
        yield* savedViews.save({
          ...input,
          id: randomUUID(),
          title: `Other ${index}`,
        });
      }
      const first = yield* savedViews.list({});
      assert.ok(first.nextCursor);
      assert.equal(
        first.rows.some((row) => row.id === recent.id),
        false,
      );
      const [newest, next] = first.rows;
      assert.ok(newest && next);
      const ids = [recent.id, removed.id, randomUUID(), newest.id, next.id];
      const hydrated = yield* savedViews.list({ ids });
      assert.equal(hydrated.rows.length, 3);
      assert.equal(hydrated.nextCursor, null);
      assert.equal(
        hydrated.rows.find((row) => row.id === recent.id)?.title,
        changed.title,
      );
      assert.equal(
        hydrated.rows.find((row) => row.id === recent.id)?.version,
        2,
      );
      assert.deepEqual(
        (yield* savedViews.list({
          ids,
          q: "fresh notes",
          cursor: first.nextCursor,
        })).rows.map((row) => row.id),
        [recent.id],
      );
      assert.deepEqual((yield* savedViews.list({ ids, q: "absent" })).rows, []);
      for (const ids of [[], [removed.id, randomUUID()]]) {
        assert.deepEqual(yield* savedViews.list({ ids }), {
          rows: [],
          nextCursor: null,
        });
      }
    }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
  );
});
