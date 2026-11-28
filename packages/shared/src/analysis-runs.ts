import { Schema } from "effect";
import { Day, Zip } from "./schema.js";
import { jobRun, jobSubmission } from "@dsiem/analytics/contracts";
export {
  AnalysisRunId,
  AnalysisRunIdFromString,
  AnalysisRunReference,
  AnalysisRunState,
  AnalysisRunSummary,
} from "@dsiem/analytics/contracts";

export const AnalysisInput = Schema.Struct({
  baselineWeek: Day,
  comparisonWeek: Day,
  minimumTrips: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type AnalysisInput = typeof AnalysisInput.Type;

export const AnalysisSubmission = jobSubmission(AnalysisInput);
export const AnalysisRun = jobRun(AnalysisInput);

export const RouteReliabilityRow = Schema.Struct({
  pickupZip: Zip,
  dropoffZip: Zip,
  timeBand: Schema.Literals(["overnight", "morning", "afternoon", "evening"]),
  baselineCount: Schema.Int.check(Schema.isGreaterThan(0)),
  comparisonCount: Schema.Int.check(Schema.isGreaterThan(0)),
  baselineP90Minutes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  comparisonP90Minutes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const RouteReliabilityReport = Schema.Struct({
  input: AnalysisInput,
  rows: Schema.Array(RouteReliabilityRow).check(Schema.isMaxLength(50)),
});
