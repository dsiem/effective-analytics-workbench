import { Notice } from "../../lib/request-state";
import { DatePicker, Dialog, Tooltip } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import {
  AnalysisInput,
  AnalysisRun,
  AnalysisRunReference,
  AnalysisRunSummary,
  RouteReliabilityReport,
} from "@dsiem/analytics-shared/analysis-runs";
import { Id } from "@dsiem/analytics-shared/schema";
import { Selection, WeekField } from "./model";

export const Message = defineMessageUnion({
  OpenAnalysisForm: {},
  CloseAnalysisForm: {},
  GotAnalysisFormDialogMessage: { message: Dialog.Message },
  GotAnalysisDatePickerMessage: { id: WeekField, message: DatePicker.Message },
  AnalysisFieldChanged: {
    field: Schema.Literals(["baselineWeek", "comparisonWeek", "minimumTrips"]),
    value: Schema.String,
  },
  StartAnalysis: {},
  AnalysisSubmitted: {
    requestId: Id,
    generation: Schema.Int,
    data: Schema.NullOr(AnalysisRunReference),
    error: Notice,
  },
  RefreshAnalysisHistory: {},
  LoadedAnalysisHistory: {
    generation: Schema.Int,
    result: Schema.Result(Schema.Array(AnalysisRunSummary), Notice),
  },
  RetryAnalysisStatus: {},
  LoadedAnalysisStatus: {
    ...Selection.fields,
    result: Schema.Result(AnalysisRun, Notice),
    observedAt: Schema.Int,
  },
  RetryAnalysisReport: {},
  LoadedAnalysisReport: {
    ...Selection.fields,
    data: Schema.NullOr(RouteReliabilityReport),
    error: Notice,
  },
  ReuseAnalysisInputs: { input: AnalysisInput },
  GotReuseTooltipMessage: { message: Tooltip.Message },
  CompletedOpenAnalysisRun: {},
});
export type Message = typeof Message.Type;
