import { test } from "node:test";
import { Result, Schema } from "effect";
import {
  click,
  Command,
  expect,
  given,
  role,
  scene,
  Subscription,
  text,
} from "foldkit/scene";
import {
  AnalysisRunId,
  type AnalysisRun,
} from "@dsiem/analytics-shared/analysis-runs";
import * as Features from "../src/app/features";
import { LoadAnalysisReport } from "../src/features/analysis-runs/commands";
import { Message } from "../src/features/analysis-runs/messages";
import { fail } from "../src/lib/command-result";
import { AccessDenied } from "../src/lib/request-state";
import { app, open } from "./app-scene";

const selection = {
  id: Schema.decodeUnknownSync(AnalysisRunId)(123),
  generation: 1,
};
const running: typeof AnalysisRun.Type = {
  id: selection.id,
  state: "running",
  requestedBy: "Avery Morgan",
  startedAt: null,
  endedAt: null,
  input: null,
  reason: null,
};
const status = (
  result: Result.Result<typeof AnalysisRun.Type, typeof AccessDenied.Type>,
  observedAt: number,
) =>
  Subscription.emit(
    Features.analysisRuns.toParentMessage(
      Message.LoadedAnalysisStatus({ ...selection, result, observedAt }),
    ),
  );

test("a denied report leaves the completed run and its inputs visible", () => {
  const message = "You need permission to read this report.";
  scene(
    app,
    given(open("/analysis?run=123")),
    status(
      Result.succeed({
        ...running,
        state: "succeeded",
        startedAt: Date.UTC(2026, 10, 19, 8),
        endedAt: Date.UTC(2026, 10, 19, 8, 1),
        input: {
          baselineWeek: "2016-01-04",
          comparisonWeek: "2016-01-11",
          minimumTrips: 50,
        },
      }),
      1,
    ),
    Command.resolve(
      LoadAnalysisReport(selection),
      Message.LoadedAnalysisReport({
        ...selection,
        result: fail(AccessDenied.make({ message })),
      }),
    ),
    expect(role("alert")).toHaveText(message),
    expect(role("heading", { name: "Run #123" })).toExist(),
    expect(text("Minimum trips per week")).toExist(),
    expect(role("button", { name: "Reuse these inputs" })).toBeEnabled(),
  );
});

test("a denied status clears the stale running state and users can retry", () => {
  const message = "You need permission to open this run.";
  scene(
    app,
    given(open("/analysis?run=123")),
    status(Result.succeed(running), 1),
    expect(role("status")).toContainText("Running"),
    status(Result.fail(AccessDenied.make({ message })), 2),
    expect(role("alert")).toHaveText(message),
    expect(text("Running")).toBeAbsent(),
    expect(text("Started by Avery Morgan")).toBeAbsent(),
    click(role("button", { name: "Check status" })),
    status(Result.succeed(running), 3),
    expect(role("status")).toContainText("Running"),
    expect(role("alert")).toBeAbsent(),
  );
});
