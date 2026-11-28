import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JobRunId,
  type AnalysisRun,
} from "@dsiem/analytics-shared/analysis-runs";
import { Option, Result, Schema } from "effect";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { LoadAnalysisReport } from "../src/features/analysis-runs/commands";
import { Message } from "../src/features/analysis-runs/messages";
import { init, type Model } from "../src/features/analysis-runs/model";
import { subscriptions } from "../src/features/analysis-runs/subscription";
import {
  openAnalysisRuns,
  updateAnalysisRuns,
} from "../src/features/analysis-runs/update";
import { fail, succeed } from "../src/lib/command-result";
import { AccessDenied } from "../src/lib/request-state";

const id = Schema.decodeUnknownSync(JobRunId)(123);
const initial = openAnalysisRuns(init(), { _tag: "SelectedRun", id }).model;
const selection = { id, generation: initial.generation };
const running: typeof AnalysisRun.Type = {
  id,
  state: "running",
  requestedBy: "Avery Morgan",
  startedAt: null,
  endedAt: null,
  input: null,
  reason: null,
};
const update = (state: Model, action: Message) =>
  updateAnalysisRuns(state, action, `run=${id}`);
const pollingSelection = (state: Model) =>
  subscriptions.analysisRun.modelToDependencies(state).selection;

test("a late report from the first visit cannot replace a denial after reopening the same run", () => {
  const input = {
    baselineWeek: "2016-01-04",
    comparisonWeek: "2016-01-11",
    minimumTrips: 75,
  };
  const completed = { ...running, state: "succeeded", input } as const;
  const status = (generation: number) =>
    Message.LoadedAnalysisStatus({
      id,
      generation,
      result: Result.succeed(completed),
      observedAt: 1,
    });
  const firstVisit = update(initial, status(selection.generation));
  const reopened = openAnalysisRuns(firstVisit.model, {
    _tag: "SelectedRun",
    id,
  }).model;
  const current = { id, generation: reopened.generation };
  const denial = AccessDenied.make({ message: "Report access was revoked." });

  story(
    update,
    given(reopened),
    message(status(current.generation)),
    Command.resolve(
      LoadAnalysisReport(current),
      Message.LoadedAnalysisReport({ ...current, result: fail(denial) }),
    ),
    message(
      Message.LoadedAnalysisReport({
        ...selection,
        result: succeed({ input, rows: [] }),
      }),
    ),
    model((state) => {
      const { report } = Option.getOrThrow(state.selected);
      assert.deepEqual(AsyncData.getError(report), Option.some(denial));
      assert.ok(Option.isNone(AsyncData.getData(report)));
    }),
  );
});

test("a denied status clears the stale run and only a retry resumes polling", () => {
  const denial = AccessDenied.make({
    message: "You need permission to open this run.",
  });

  story(
    update,
    given(initial),
    message(
      Message.LoadedAnalysisStatus({
        ...selection,
        result: Result.succeed(running),
        observedAt: 1,
      }),
    ),
    model((state) => {
      assert.deepEqual(pollingSelection(state), Option.some(selection));
    }),
    message(
      Message.LoadedAnalysisStatus({
        ...selection,
        result: Result.fail(denial),
        observedAt: 2,
      }),
    ),
    model((state) => {
      const { detail } = Option.getOrThrow(state.selected);
      assert.deepEqual(AsyncData.getData(detail), Option.none());
      assert.deepEqual(AsyncData.getError(detail), Option.some(denial));
      assert.deepEqual(pollingSelection(state), Option.none());
    }),
    message(Message.RetryAnalysisStatus()),
    model((state) => {
      assert.deepEqual(pollingSelection(state), Option.some(selection));
    }),
  );
});
