import { DatePicker, Dialog, Tooltip } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import {
  AnalysisRun,
  JobRunId,
  type JobRunState,
  JobRunSummary,
  RouteReliabilityReport,
} from "@dsiem/analytics-shared/analysis-runs";
import { Id } from "@dsiem/analytics-shared/schema";
import { Notice } from "../../lib/request-state";

export const Draft = Schema.Struct({
  baselineWeek: Schema.String,
  comparisonWeek: Schema.String,
  minimumTrips: Schema.String,
});
export const WeekField = Schema.Literals(["baselineWeek", "comparisonWeek"]);
export type WeekField = typeof WeekField.Type;

export const Selection = Schema.Struct({
  id: JobRunId,
  generation: Schema.Int,
});

export const Submission = defineTaggedUnion({
  Ready: { retryId: Schema.Option(Id), error: Notice },
  Submitting: { generation: Schema.Int },
});

export const readyToSubmit = (
  retryId: Option.Option<typeof Id.Type> = Option.none(),
  error: Notice = "",
) => Submission.Ready({ retryId, error });

export const initReuseTooltip = () => Tooltip.init({ id: "reuse-inputs" });

const SelectedRun = Schema.Struct({
  ...Selection.fields,
  detail: AsyncData.Schema(AnalysisRun, Notice).schema,
  report: AsyncData.Schema(RouteReliabilityReport, Notice).schema,
  observedAt: Schema.Int,
});
export type SelectedRun = typeof SelectedRun.Type;

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  reuseTooltip: Tooltip.Model,
  draft: Draft,
  datePickers: Schema.Option(
    Schema.Struct({
      baselineWeek: DatePicker.Model,
      comparisonWeek: DatePicker.Model,
    }),
  ),
  submission: Submission,
  generation: Schema.Int,
  invalidLink: Schema.Boolean,
  historyGeneration: Schema.Int,
  recent: AsyncData.Schema(Schema.Array(JobRunSummary), Notice).schema,
  selected: Schema.Option(SelectedRun),
});
export type Model = typeof Model.Type;

export const defaultDraft: Model["draft"] = {
  baselineWeek: "",
  comparisonWeek: "",
  minimumTrips: "50",
};

export const init = (): Model => ({
  dialog: Dialog.init({
    id: "analysis-run-form",
    focusSelector: "#analysis-baseline-week",
  }),
  reuseTooltip: initReuseTooltip(),
  draft: defaultDraft,
  datePickers: Option.none(),
  submission: readyToSubmit(),
  generation: 0,
  invalidLink: false,
  historyGeneration: 0,
  recent: AsyncData.Idle(),
  selected: Option.none(),
});

export const isActive = (state: JobRunState) =>
  state === "queued" || state === "running";

export const watchedRun = (
  model: Model,
): Option.Option<typeof Selection.Type> =>
  model.selected.pipe(
    Option.filter(
      ({ detail }) =>
        AsyncData.isPending(detail) ||
        AsyncData.getData(detail).pipe(
          Option.exists((run) => isActive(run.state)),
        ),
    ),
    Option.map(({ id, generation }) => ({ id, generation })),
  );
