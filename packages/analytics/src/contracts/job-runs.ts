import { Schema } from "effect";
import { Id } from "./fields.js";

export const AnalysisRunId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand("AnalysisRunId"));
export type AnalysisRunId = typeof AnalysisRunId.Type;

export const AnalysisRunIdFromString = Schema.String.check(
  Schema.isPattern(/^[1-9]\d*$/),
).pipe(
  Schema.decodeTo(Schema.NumberFromString),
  Schema.decodeTo(AnalysisRunId),
);

export const AnalysisRunReference = Schema.Struct({ id: AnalysisRunId });

export const AnalysisRunState = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);
export type AnalysisRunState = typeof AnalysisRunState.Type;

export const AnalysisRunSummary = Schema.Struct({
  id: AnalysisRunId,
  state: AnalysisRunState,
  startedAt: Schema.NullOr(Schema.Int),
  endedAt: Schema.NullOr(Schema.Int),
  requestedBy: Schema.NullOr(Schema.NonEmptyString),
});
export type AnalysisRunSummary = typeof AnalysisRunSummary.Type;

export const jobSubmission = <Input extends Schema.Top>(input: Input) =>
  Schema.Struct({ input, requestId: Id });

export const jobRun = <Input extends Schema.Top>(input: Input) =>
  Schema.Struct({
    ...AnalysisRunSummary.fields,
    input: Schema.NullOr(input),
    reason: Schema.NullOr(Schema.String),
    reasonCode: Schema.optionalKey(Schema.Literal("permission_denied")),
  });

export const localRunSchema = <Input extends Schema.Top>(input: Input) =>
  Schema.Struct({ id: AnalysisRunId, input, completedAt: Schema.String });
