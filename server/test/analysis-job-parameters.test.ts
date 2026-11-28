import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Schema } from "effect";
import { AnalysisRunId } from "@dsiem/analytics/contracts";
import { makeAnalysisJob } from "@dsiem/analytics/jobs";

test("dictionary job inputs exclude viewer attribution and unresolved historical parameters", async () => {
  const id = Schema.decodeUnknownSync(AnalysisRunId)(17);
  await Effect.runPromise(
    Effect.gen(function* () {
      const job = makeAnalysisJob(
        (path) =>
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
