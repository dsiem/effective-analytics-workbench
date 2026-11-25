import { DatePicker, Dialog, Tooltip } from "@foldkit/ui";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import {
  AnalysisRun,
  AnalysisRunId,
  type AnalysisRunState,
  AnalysisRunSummary,
  RouteReliabilityReport,
} from "@dsiem/analytics-shared/analysis-runs";
import { Id } from "@dsiem/analytics-shared/schema";
import { Notice, request } from "../../lib/request-state";

export const Draft = Schema.Struct({
  baselineWeek: Schema.String,
  comparisonWeek: Schema.String,
  minimumTrips: Schema.String,
});
export const WeekField = Schema.Literals(["baselineWeek", "comparisonWeek"]);
export type WeekField = typeof WeekField.Type;

export const Selection = Schema.Struct({
  id: AnalysisRunId,
  generation: Schema.Int,
});

const Ready = Schema.TaggedStruct("Ready", {
  retryId: Schema.NullOr(Id),
  error: Notice,
});
const Submission = Schema.Union([
  Ready,
  Schema.TaggedStruct("Submitting", { generation: Schema.Int }),
]);

export const readyToSubmit = (
  retryId: string | null = null,
  error: Notice = "",
) => Ready.make({ retryId, error });

export const initReuseTooltip = () => Tooltip.init({ id: "reuse-inputs" });

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  reuseTooltip: Tooltip.Model,
  draft: Draft,
  datePickers: Schema.NullOr(
    Schema.Struct({
      baselineWeek: DatePicker.Model,
      comparisonWeek: DatePicker.Model,
    }),
  ),
  submission: Submission,
  generation: Schema.Int,
  invalidLink: Schema.Boolean,
  historyGeneration: Schema.Int,
  recent: AsyncData.Schema(Schema.Array(AnalysisRunSummary), Notice).schema,
  selected: Schema.NullOr(
    Schema.Struct({
      ...Selection.fields,
      detail: request(AnalysisRun),
      report: request(RouteReliabilityReport),
      observedAt: Schema.Int,
    }),
  ),
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
  datePickers: null,
  submission: readyToSubmit(),
  generation: 0,
  invalidLink: false,
  historyGeneration: 0,
  recent: AsyncData.Idle(),
  selected: null,
});

export const isActive = (state: AnalysisRunState) =>
  state === "queued" || state === "running";

export const watchedRun = (model: Model): typeof Selection.Type | null => {
  const selected = model.selected;
  if (
    selected &&
    (selected.detail.loading ||
      (selected.detail.data && isActive(selected.detail.data.state)))
  ) {
    return { id: selected.id, generation: selected.generation };
  }
  return null;
};
