import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result, Schema } from "effect";
import { AsyncData } from "foldkit";
import {
  AnalysisRunId,
  type AnalysisRunSummary,
} from "@dsiem/analytics-shared/analysis-runs";
import { Message as M } from "../src/features/analysis-runs/messages";
import { init } from "../src/features/analysis-runs/model";
import {
  openAnalysisRuns,
  updateAnalysisRuns,
} from "../src/features/analysis-runs/update";

const run: AnalysisRunSummary = {
  id: Schema.decodeUnknownSync(AnalysisRunId)(123),
  state: "succeeded",
  startedAt: null,
  endedAt: null,
  requestedBy: null,
};

test("refreshing history keeps the recent list visible through a failure", () => {
  const opened = openAnalysisRuns(init(), { _tag: "NoRun" }).model;
  const loaded = updateAnalysisRuns(
    opened,
    M.LoadedAnalysisHistory({
      generation: opened.historyGeneration,
      result: Result.succeed([run]),
    }),
    "",
  ).model;
  const refreshing = updateAnalysisRuns(loaded, M.RefreshAnalysisHistory(), "");

  assert.ok(AsyncData.isPending(refreshing.model.recent));
  assert.deepEqual(
    Option.getOrUndefined(AsyncData.getData(refreshing.model.recent)),
    [run],
  );
  const duplicate = updateAnalysisRuns(
    refreshing.model,
    M.RefreshAnalysisHistory(),
    "",
  );
  assert.equal(duplicate.model, refreshing.model);
  assert.equal(duplicate.commands, undefined);

  const failed = updateAnalysisRuns(
    refreshing.model,
    M.LoadedAnalysisHistory({
      generation: refreshing.model.historyGeneration,
      result: Result.fail("History unavailable"),
    }),
    "",
  ).model;
  assert.equal(AsyncData.isPending(failed.recent), false);
  assert.deepEqual(Option.getOrUndefined(AsyncData.getData(failed.recent)), [
    run,
  ]);
  assert.equal(
    Option.getOrUndefined(AsyncData.getError(failed.recent)),
    "History unavailable",
  );
});

test("a completed submission can refresh pending history without accepting older replies", () => {
  const opened = openAnalysisRuns(init(), { _tag: "NoRun" }).model;
  const form = updateAnalysisRuns(opened, M.OpenAnalysisForm(), "").model;
  const withBaseline = updateAnalysisRuns(
    form,
    M.AnalysisFieldChanged({ field: "baselineWeek", value: "2016-01-04" }),
    "",
  ).model;
  const withDates = updateAnalysisRuns(
    withBaseline,
    M.AnalysisFieldChanged({ field: "comparisonWeek", value: "2016-01-11" }),
    "",
  ).model;
  const submitted = updateAnalysisRuns(withDates, M.StartAnalysis(), "");
  assert.equal(submitted.model.submission._tag, "Submitting");
  const reopened = openAnalysisRuns(submitted.model, { _tag: "NoRun" });
  assert.deepEqual(
    reopened.commands?.map(({ name }) => name),
    ["LoadAnalysisHistory"],
  );

  const refreshed = updateAnalysisRuns(
    reopened.model,
    M.AnalysisSubmitted({
      generation: submitted.model.generation,
      data: { id: run.id },
      requestId: "00000000-0000-4000-8000-000000000001",
      error: "",
    }),
    "",
  );
  assert.deepEqual(
    refreshed.commands?.map(({ name }) => name),
    ["LoadAnalysisHistory"],
  );

  const current = updateAnalysisRuns(
    refreshed.model,
    M.LoadedAnalysisHistory({
      generation: refreshed.model.historyGeneration,
      result: Result.succeed([run]),
    }),
    "",
  ).model;
  const old = updateAnalysisRuns(
    current,
    M.LoadedAnalysisHistory({
      generation: reopened.model.historyGeneration,
      result: Result.succeed([]),
    }),
    "",
  );
  assert.deepEqual(Option.getOrUndefined(AsyncData.getData(current.recent)), [
    run,
  ]);
  assert.equal(old.model, current);
});
