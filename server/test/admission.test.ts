import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Redacted,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { makeAdmission } from "../src/admission.js";
import { Analytics } from "../src/taxi/analytics.js";
import { OperationTimeout, unavailable } from "../src/errors.js";
import { Genie } from "../src/genie/service.js";
import { Settings } from "../src/settings.js";
import { Warehouse } from "../src/warehouse.js";
import { Workspace } from "../src/workspace.js";
import { warehouseFetch } from "./warehouse-fixture.js";

const settings = (env: Record<string, string> = {}) =>
  Settings.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          DATABRICKS_HOST: "https://workspace.invalid",
          DATABRICKS_WAREHOUSE_ID: "warehouse",
          TRIP_SNAPSHOT_TABLE: "test.snapshot.trips",
          GENIE_SPACE_ID: "space",
          ...env,
        }),
      ),
    ),
  );
const workspace = (
  request: typeof Workspace.Service.request = () =>
    Effect.die("Unexpected workspace request"),
) =>
  Layer.succeed(Workspace, {
    requestEvents: () => Effect.die("Unexpected workspace event request"),
    accessToken: Effect.succeed(Redacted.make("unused")),
    request,
  });

for (const outcome of ["failure", "defect", "interruption"] as const) {
  test(
    `admission releases capacity after ${outcome} and removes cancelled waiters`,
    {
      timeout: 5000,
    },
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { effect: admit } = makeAdmission({
            service: "warehouse",
            concurrency: 1,
            timeout: "90 seconds",
          });
          const entered = Latch.makeUnsafe();
          const finish = Latch.makeUnsafe();
          const diagnostic = new Error("Diagnostic");
          const running = yield* admit(
            Effect.gen(function* () {
              yield* entered.open;
              yield* finish.await;
              if (outcome === "failure") return yield* Effect.fail(diagnostic);
              if (outcome === "defect") return yield* Effect.die(diagnostic);
              return yield* Effect.interrupt;
            }),
          ).pipe(Effect.forkChild);
          yield* entered.await;
          let abandonedStarted = false;
          const cancelled = yield* admit(
            Effect.sync(() => {
              abandonedStarted = true;
            }),
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("1 millis");
          yield* Fiber.interrupt(cancelled);
          yield* finish.open;
          const exit = yield* Fiber.await(running);
          assert.ok(Exit.isFailure(exit));
          if (outcome === "failure")
            assert.equal(Cause.squash(exit.cause), diagnostic);
          else if (outcome === "defect") assert.ok(Cause.hasDies(exit.cause));
          else assert.ok(Cause.hasInterruptsOnly(exit.cause));
          assert.equal(
            yield* admit(Effect.succeed("replacement")),
            "replacement",
          );
          assert.equal(abandonedStarted, false);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );
}

test(
  "a queued deadline expires without starting work while earlier work is cleaning up",
  {
    timeout: 5000,
  },
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { effect: admit } = makeAdmission({
          service: "warehouse",
          concurrency: 1,
          timeout: "30 seconds",
        });
        const entered = Latch.makeUnsafe();
        const cleanup = Latch.makeUnsafe();
        const running = yield* admit(
          entered.open.pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => cleanup.await),
          ),
        ).pipe(Effect.forkChild);
        yield* entered.await;
        yield* TestClock.adjust("1 second");
        let queuedStarted = false;
        const queued = yield* admit(
          Effect.sync(() => {
            queuedStarted = true;
          }),
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const exit = yield* Fiber.await(queued);
        assert.ok(Exit.isFailure(exit));
        const error = Cause.squash(exit.cause);
        assert.ok(error instanceof OperationTimeout);
        assert.equal(error.service, "warehouse");
        assert.equal(queuedStarted, false);
        yield* cleanup.open;
        yield* Fiber.await(running);
        assert.equal(
          yield* admit(Effect.succeed("replacement")),
          "replacement",
        );
        assert.equal(
          queuedStarted,
          false,
          "expired work must never be admitted later",
        );
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);

test(
  "distinct overview, trip, and metadata requests share the warehouse statement limit",
  {
    timeout: 5000,
  },
  async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const saturated = Latch.makeUnsafe();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    let statements = 0;
    globalThis.fetch = warehouseFetch(async () => {
      statements++;
      active++;
      peak = Math.max(peak, active);
      if (active === 2) saturated.openUnsafe();
      await gate;
      active--;
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* Analytics;
        const requests = yield* Effect.all(
          [
            analytics.overview({}),
            analytics.overview({ zip: "10001" }),
            analytics.trips({ sort: "newest" }),
            analytics.trips({ sort: "fare" }),
            analytics.tripMap({}),
            analytics.metadata,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* saturated.await;
        yield* TestClock.adjust("1 millis");
        assert.equal(
          statements,
          2,
          "all request types must wait on the same admission pool",
        );
        release();
        yield* Fiber.join(requests);
        assert.equal(peak, 2);
      }).pipe(
        Effect.provide(
          Analytics.layer
            .pipe(Layer.provide(Warehouse.layer))
            .pipe(
              Layer.provide(workspace()),
              Layer.provide(settings({ WAREHOUSE_MAX_CONCURRENCY: "2" })),
            ),
        ),
        Effect.provide(TestClock.layer()),
      ),
    );
  },
);

test(
  "cancelled warehouse requests never submit their queued statements",
  {
    timeout: 5000,
  },
  async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const entered = Latch.makeUnsafe();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let statements = 0;
    globalThis.fetch = warehouseFetch(async () => {
      statements++;
      entered.openUnsafe();
      await gate;
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* Analytics;
        const running = yield* analytics.metadata.pipe(Effect.forkChild);
        yield* entered.await;
        const overview = yield* analytics
          .overview({ zip: "10001" })
          .pipe(Effect.forkChild);
        const trips = yield* analytics
          .trips({ sort: "fare" })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 millis");
        yield* Fiber.interrupt(overview);
        yield* Fiber.interrupt(trips);
        release();
        yield* Fiber.join(running);
        yield* analytics.trips({ sort: "distance" });
        assert.equal(
          statements,
          2,
          "only metadata and the replacement trip batch may execute",
        );
      }).pipe(
        Effect.provide(
          Analytics.layer
            .pipe(Layer.provide(Warehouse.layer))
            .pipe(
              Layer.provide(workspace()),
              Layer.provide(settings({ WAREHOUSE_MAX_CONCURRENCY: "1" })),
            ),
        ),
        Effect.provide(TestClock.layer()),
      ),
    );
  },
);

const operation = { conversationId: "conversation", messageId: "message" };
const accepted = {
  conversation_id: "conversation",
  message_id: "message",
  message: { message_id: "message" },
};

test(
  "Genie submissions share a separate limit without blocking reads or warehouse work",
  {
    timeout: 5000,
  },
  async (t) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = warehouseFetch();
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const saturated = Latch.makeUnsafe();
    const release = Latch.makeUnsafe();
    let submissions = 0;
    let active = 0;
    let peak = 0;
    const services = Layer.mergeAll(
      Genie.layer,
      Analytics.layer.pipe(Layer.provide(Warehouse.layer)),
    ).pipe(
      Layer.provide(
        workspace((_path, method) =>
          method === "POST"
            ? Effect.gen(function* () {
                submissions++;
                active++;
                peak = Math.max(peak, active);
                if (active === 2) yield* saturated.open;
                yield* release.await;
                return accepted;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active--;
                  }),
                ),
              )
            : Effect.succeed({
                ...accepted,
                status: "COMPLETED",
                attachments: [],
              }),
        ),
      ),
      Layer.provide(
        settings({
          GENIE_MAX_CONCURRENCY: "2",
          WAREHOUSE_MAX_CONCURRENCY: "1",
        }),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const { forViewer } = yield* Genie;
        const genie = yield* forViewer(undefined);
        const requests = yield* Effect.all(
          Array.from({ length: 6 }, (_, index) =>
            genie.submit({
              content: `Question ${index}`,
              ...(index % 2 ? { conversationId: "conversation" } : {}),
            }),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* saturated.await;
        yield* TestClock.adjust("1 millis");
        assert.equal(submissions, 2);
        assert.equal((yield* genie.poll(operation)).state, "completed");
        assert.equal((yield* genie.result(operation)).text, "");
        assert.equal((yield* (yield* Analytics).metadata).trips, 10);
        yield* release.open;
        yield* Fiber.join(requests);
        assert.equal(submissions, 6);
        assert.equal(peak, 2);
      }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
    );
  },
);

test(
  "a cancelled queued Genie submission is never posted and capacity remains usable",
  {
    timeout: 5000,
  },
  async () => {
    const entered = Latch.makeUnsafe();
    const release = Latch.makeUnsafe();
    let submissions = 0;
    const services = Genie.layer.pipe(
      Layer.provide(
        workspace(() =>
          Effect.gen(function* () {
            submissions++;
            yield* entered.open;
            yield* release.await;
            return accepted;
          }),
        ),
      ),
      Layer.provide(settings({ GENIE_MAX_CONCURRENCY: "1" })),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const { forViewer } = yield* Genie;
        const genie = yield* forViewer(undefined);
        const running = yield* genie
          .submit({ content: "First" })
          .pipe(Effect.forkChild);
        yield* entered.await;
        const cancelled = yield* genie
          .submit({ content: "Abandoned" })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 millis");
        yield* Fiber.interrupt(cancelled);
        yield* release.open;
        yield* Fiber.join(running);
        yield* genie.submit({
          content: "Replacement",
          conversationId: "conversation",
        });
        assert.equal(submissions, 2);
      }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
    );
  },
);

test(
  "Genie submission deadlines include admission waiting and never replay a timed out POST",
  {
    timeout: 5000,
  },
  async () => {
    const entered = Latch.makeUnsafe();
    let submissions = 0;
    const services = Genie.layer.pipe(
      Layer.provide(
        workspace(() =>
          Effect.gen(function* () {
            submissions++;
            yield* entered.open;
            return yield* Effect.never;
          }),
        ),
      ),
      Layer.provide(settings({ GENIE_MAX_CONCURRENCY: "1" })),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const { forViewer } = yield* Genie;
        const genie = yield* forViewer(undefined);
        const running = yield* genie
          .submit({ content: "First" })
          .pipe(Effect.forkChild);
        yield* entered.await;
        const cancelled = yield* genie.submit({ content: "Abandoned" }).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.fail(unavailable("warehouse", "caller deadline")),
          }),
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 seconds");
        const abandoned = yield* Fiber.await(cancelled);
        assert.ok(Exit.isFailure(abandoned));
        assert.equal(submissions, 1);
        yield* TestClock.adjust("20 seconds");
        const exit = yield* Fiber.await(running);
        assert.ok(Exit.isFailure(exit));
        const error = Cause.squash(exit.cause);
        assert.ok(error instanceof OperationTimeout);
        assert.equal(error.service, "genie");
        assert.equal(submissions, 1);
      }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
    );
  },
);
