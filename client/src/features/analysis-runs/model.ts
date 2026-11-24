import { DatePicker, Dialog, Tooltip } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import {
  AnalysisRun,
  AnalysisRunId,
  AnalysisRunIdFromString,
  type AnalysisRunState,
  AnalysisRunSummary,
  RouteReliabilityReport,
} from "../../../../shared/analysis-runs";
import { pagePaths } from "../../../../shared/page-paths";
import { Id } from "../../../../shared/schema";
import { href } from "../../domain/filters";
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

export const AnalysisRunLink = Schema.Union([
  Schema.TaggedStruct("NoRun", {}),
  Schema.TaggedStruct("InvalidRun", {}),
  Schema.TaggedStruct("SelectedRun", { id: AnalysisRunId }),
]);
export type AnalysisRunLink = typeof AnalysisRunLink.Type;

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

export function parseRunLink(run: string | null): AnalysisRunLink {
  if (run === null) return { _tag: "NoRun" };
  const id = Schema.decodeUnknownOption(AnalysisRunIdFromString)(run);
  return Option.isSome(id)
    ? { _tag: "SelectedRun", id: id.value }
    : { _tag: "InvalidRun" };
}
export const withoutRun = (query: string) => {
  const params = new URLSearchParams(query);
  if (!params.has("run")) return query;
  params.delete("run");
  return params.toString();
};
export const historyHref = (query: string) =>
  href(pagePaths.AnalysisRuns, withoutRun(query));
export const runHref = (id: AnalysisRunId, query: string) => {
  const params = new URLSearchParams(query);
  params.set("run", String(id));
  return `${pagePaths.AnalysisRuns}?${params}`;
};
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
