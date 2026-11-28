import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, Effect, Schema } from "effect";
import { Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { createQueryPage } from "../src/query-page.js";

class Inventory extends Context.Service<
  Inventory,
  { available: Effect.Effect<number, string> }
>()("test/Inventory") {}

test("a parent routes a report's commands, retries a failure, and ignores a superseded response", async () => {
  const report = createQueryPage({
    result: Schema.Natural,
    load: Effect.flatMap(Inventory, (service) => service.available),
  });
  const Message = defineMessageUnion({ Stock: { message: report.Message } });
  const fold = (result: ReturnType<typeof report.init>) =>
    Update.foldChildInit(result, {
      toParentModel: (report) => ({ report }),
      toParentMessage: (message) => Message.Stock({ message }),
    });
  const boot = fold(report.init());
  const first = boot.commands?.[0];
  assert.ok(first);
  const failure = await Effect.runPromise(
    first.effect.pipe(
      Effect.provideService(Inventory, {
        available: Effect.fail("Inventory is offline"),
      }),
    ),
  );
  assert.equal(failure._tag, "Stock");
  const failed = fold(report.update(boot.model.report, failure.message));
  assert.equal(failed.model.report._tag, "Failed");

  const retry = fold(
    report.update(failed.model.report, report.Message.Retry()),
  );
  const next = retry.commands?.[0];
  assert.ok(next);
  const late = report.update(retry.model.report, failure.message);
  assert.equal(late.model._tag, "Loading");
  const recovery = await Effect.runPromise(
    next.effect.pipe(
      Effect.provideService(Inventory, { available: Effect.succeed(7) }),
    ),
  );
  const recovered = fold(report.update(late.model, recovery.message));
  assert.equal(recovered.model.report._tag, "Loaded");
  assert.equal(recovered.model.report.data, 7);
});
