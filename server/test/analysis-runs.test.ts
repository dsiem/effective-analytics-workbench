import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { AnalysisRun } from "../../shared/analysis-runs.js";
import { PermissionDeniedBody } from "../../shared/api.js";
import { AnalysisRuns } from "../src/analysis-runs.js";
import { Analytics } from "../src/taxi/analytics.js";
import { Genie } from "../src/genie/service.js";
import { Lakebase } from "../src/lakebase.js";
import { Routes } from "../src/routes.js";
import { SavedViews } from "../src/saved-views.js";
import { Settings } from "../src/settings.js";
import { TripComments } from "../src/trip-comments.js";
import { Warehouse } from "../src/warehouse.js";
import { Workspace } from "../src/workspace.js";
import { warehouseFetch } from "./warehouse-fixture.js";

test("analysis runs record the requester across retries, scope history and results, and read an empty report", async (t) => {
  const input = {
    baselineWeek: "2016-01-04",
    comparisonWeek: "2016-01-11",
    minimumTrips: 50,
  };
  const jobParameters = {
    baseline_week: input.baselineWeek,
    comparison_week: input.comparisonWeek,
    minimum_trips: String(input.minimumTrips),
    requested_by: "Avery Morgan",
  };
  const report = { input, rows: [] };
  const submissions: unknown[] = [];
  let state = "QUEUED";
  let termination = "SUCCESS";
  let denyJob = false;
  let reads = 0;
  let denyReport = false;
  const sql = warehouseFetch(async (statement, _signal, parameters) => {
    reads++;
    assert.match(
      statement,
      /`custom`\.`taxi-schema`\.`route_reliability_runs`/,
    );
    assert.match(statement, /WHERE run_id = CAST\(:\w+ AS BIGINT\)/);
    assert.deepEqual(
      parameters.map(({ value }) => value),
      ["123"],
    );
    return [{ report_json: JSON.stringify(report) }];
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/2.2/jobs/")) {
      if (denyReport)
        return Response.json({
          statement_id: "denied",
          status: {
            state: "FAILED",
            error: {
              error_code: "PERMISSION_DENIED",
              message: "internal diagnostic",
            },
          },
        });
      return sql(request);
    }
    if (denyJob)
      return Response.json({ message: "private diagnostic" }, { status: 403 });
    const legacy = { job_id: 456, run_id: 125, status: { state } };
    const run = {
      ...legacy,
      run_id: 123,
      job_parameters: Object.entries(jobParameters).map(([name, value]) => ({
        name,
        value,
      })),
    };
    switch (url.pathname) {
      case "/api/2.2/jobs/run-now":
        submissions.push(await request.json());
        return submissions.length === 1
          ? Response.json({}, { status: 503 })
          : Response.json({ run_id: run.run_id });
      case "/api/2.2/jobs/runs/list":
        assert.equal(url.searchParams.get("job_id"), "456");
        return Response.json({
          runs: [run, { ...run, job_id: 789, run_id: 124 }, legacy],
        });
      case "/api/2.2/jobs/runs/get":
        return Response.json({
          ...run,
          ...(url.searchParams.get("run_id") === "124"
            ? { job_id: 789, run_id: 124 }
            : {}),
          status:
            state === "TERMINATED"
              ? { state, termination_details: { code: termination } }
              : { state },
        });
      default:
        throw new Error(`Unexpected request to ${url.pathname}`);
    }
  };
  const services = Layer.mergeAll(
    Analytics.layer,
    AnalysisRuns.layer,
    Genie.layer,
    SavedViews.layer,
    TripComments.layer,
  ).pipe(
    Layer.provideMerge(Lakebase.layer),
    Layer.provideMerge(Warehouse.layer),
    Layer.provideMerge(Workspace.layer),
    Layer.provideMerge(Settings.layer),
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          DATABRICKS_HOST: "https://workspace.invalid",
          DATABRICKS_TOKEN: "fixture",
          GENIE_SPACE_ID: "fixture-space",
          DATABRICKS_WAREHOUSE_ID: "warehouse",
          TRIP_SNAPSHOT_TABLE: "custom.taxi-schema.trips",
          ANALYSIS_JOB_ID: "456",
          ANALYSIS_RESULTS_TABLE: "custom.taxi-schema.route_reliability_runs",
        }),
      ),
    ),
  );
  const app = HttpRouter.toWebHandler(
    Routes.pipe(
      Layer.provide(services),
      Layer.provideMerge(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  t.after(app.dispose);
  const api = (path = "", init?: RequestInit) =>
    app.handler(new Request(`http://localhost/api/analysis-runs${path}`, init));
  const submit = (analysis = input) =>
    api("", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-preferred-username": "Avery Morgan",
        "x-forwarded-email": "avery@example.com",
      },
      body: JSON.stringify({
        input: analysis,
        requestId: "52545413-6df3-4669-9e53-200b323b4001",
        requestedBy: "Forged name",
      }),
    });

  assert.equal(
    (await submit({ ...input, comparisonWeek: "2016-02-30" })).status,
    400,
  );
  assert.equal(submissions.length, 0);
  assert.equal((await submit()).status, 502);
  const accepted = await submit();
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { id: 123 });
  assert.deepEqual(submissions[0], submissions[1]);
  const [submitted] = submissions;
  assert.ok(
    submitted &&
      typeof submitted === "object" &&
      "idempotency_token" in submitted,
  );
  assert.ok(typeof submitted.idempotency_token === "string");
  assert.match(submitted.idempotency_token, /^[a-f0-9]{64}$/);
  assert.deepEqual(submissions[1], {
    job_id: 456,
    job_parameters: jobParameters,
    idempotency_token: submitted.idempotency_token,
  });
  assert.deepEqual(await (await api()).json(), [
    {
      id: 123,
      state: "queued",
      startedAt: null,
      endedAt: null,
      requestedBy: "Avery Morgan",
    },
    {
      id: 125,
      state: "queued",
      startedAt: null,
      endedAt: null,
      requestedBy: null,
    },
  ]);
  assert.deepEqual(await (await api("/123")).json(), {
    id: 123,
    state: "queued",
    startedAt: null,
    endedAt: null,
    requestedBy: "Avery Morgan",
    input,
    reason: null,
  });
  assert.equal((await api("/123/result")).status, 409);
  assert.equal((await api("/124")).status, 404);
  assert.equal((await api("/124/result")).status, 404);
  assert.equal(reads, 0);

  state = "TERMINATED";
  const result = await api("/123/result");
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), report);
  assert.equal(reads, 1);
  denyReport = true;
  const denied = await api("/123/result");
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    error: {
      code: "permission_denied",
      message: "This report is under lock. You need permission to read it.",
    },
  });
  assert.equal((await api("/123")).status, 200);

  termination = "UNAUTHORIZED_ERROR";
  const execution = await api("/123");
  assert.equal(execution.status, 200);
  const failedRun = Schema.decodeUnknownSync(AnalysisRun)(
    await execution.json(),
  );
  assert.equal(failedRun.state, "failed");
  assert.equal(failedRun.reasonCode, "permission_denied");
  assert.ok(failedRun.reason);
  assert.match(failedRun.reason, /permission to complete the analysis/);

  denyJob = true;
  for (const [response, action] of [
    [await submit(), /Starting an analysis requires permission/],
    [await api(), /permission to browse/],
    [await api("/123"), /permission to open/],
    [await api("/123/result"), /permission to open/],
  ] as const) {
    assert.equal(response.status, 403);
    const { error } = Schema.decodeUnknownSync(PermissionDeniedBody)(
      await response.json(),
    );
    assert.match(error.message, action);
    assert.doesNotMatch(error.message, /private diagnostic/);
  }
});
