import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Schema } from "effect";
import { JobRunId } from "@dsiem/analytics/contracts";
import { bindJob } from "@dsiem/analytics/jobs";

test("dictionary job inputs exclude viewer attribution and unresolved historical parameters", async () => {
  const id = Schema.decodeUnknownSync(JobRunId)(17);
  await Effect.runPromise(
    Effect.gen(function* () {
      const job = bindJob(
        {
          statusOf: () => undefined,
          request: (path) =>
            Effect.sync(() => {
              assert.match(path, /runs\/get/);
              return {
                job_id: 8,
                run_id: id,
                job_parameters: [
                  { name: "requested_by", value: "Sam" },
                  { name: "conversion", default: "USD" },
                  { name: "withdrawn" },
                ],
              };
            }),
        },
        {
          jobId: 8,
          parameters: Schema.Record(Schema.String, Schema.String),
          readReport: () => Effect.succeed(Option.some("done")),
        },
      );
      const run = yield* job.get(id);
      assert.deepEqual(run.input, { conversion: "USD" });
      assert.equal(run.requestedBy, "Sam");
      const failure = yield* Effect.flip(
        job.submit(
          {
            input: { requested_by: "Forged name" },
            requestId: "fx-analysis",
          },
          "Sam",
        ),
      );
      assert.equal(failure._tag, "InvalidRequest");
    }),
  );
});

test("Jobs normalizes response statuses from a custom transport at the operation boundary", async () => {
  const id = Schema.decodeUnknownSync(JobRunId)(17);
  const failedJob = (status: number) =>
    bindJob(
      {
        request: () => Effect.fail({ status }),
        statusOf: (failure) => failure.status,
      },
      {
        jobId: 8,
        parameters: Schema.Record(Schema.String, Schema.String),
        readReport: () => Effect.succeed(Option.some("done")),
      },
    );
  const missing = failedJob(404);
  for (const lookup of [
    Effect.asVoid(missing.get(id)),
    Effect.asVoid(missing.result(id)),
  ]) {
    const error = await Effect.runPromise(Effect.flip(lookup));
    assert.ok("_tag" in error && error._tag === "JobRunNotFound");
  }
  assert.deepEqual(await Effect.runPromise(Effect.flip(missing.list)), {
    status: 404,
  });
  const denied = await Effect.runPromise(Effect.flip(failedJob(403).get(id)));
  assert.ok("_tag" in denied && denied._tag === "PermissionDenied");
  assert.deepEqual(
    await Effect.runPromise(Effect.flip(failedJob(500).get(id))),
    { status: 500 },
  );
});
