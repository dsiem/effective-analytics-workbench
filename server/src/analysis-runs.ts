import { Context, Effect, Layer, Schema } from "effect";
import {
  AnalysisInput,
  RouteReliabilityReport,
} from "@dsiem/analytics-shared/analysis-runs";
import { bindJob } from "@dsiem/analytics/jobs";
import { Workspace } from "./workspace.js";
import { warehouseJsonReport } from "./jobs/sql-json-report.js";
import { Settings } from "./settings.js";
import { Warehouse } from "./warehouse.js";

const parameters = Schema.Struct({
  ...AnalysisInput.fields,
  minimumTrips: Schema.NumberFromString.pipe(
    Schema.decodeTo(AnalysisInput.fields.minimumTrips),
  ),
}).pipe(
  Schema.encodeKeys({
    baselineWeek: "baseline_week",
    comparisonWeek: "comparison_week",
    minimumTrips: "minimum_trips",
  }),
);

const makeAnalysisRuns = Effect.gen(function* () {
  const { analysisJobId, analysisResultsTable } = yield* Settings;
  const warehouse = yield* Warehouse;
  return bindJob(
    {
      request: (yield* Workspace).request,
      statusOf: (error) =>
        error._tag === "UpstreamError" ? error.upstreamStatus : undefined,
    },
    {
      jobId: analysisJobId || null,
      parameters,
      readReport: warehouseJsonReport({
        warehouse,
        tableName: analysisResultsTable,
        report: RouteReliabilityReport,
      }),
    },
  );
});

export class AnalysisRuns extends Context.Service<
  AnalysisRuns,
  Effect.Success<typeof makeAnalysisRuns>
>()("app/AnalysisRuns") {
  static readonly layer = Layer.effect(this, makeAnalysisRuns);
}
