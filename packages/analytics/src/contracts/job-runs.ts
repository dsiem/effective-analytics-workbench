import { Schema } from "effect";
import { Id } from "./fields.js";

export const JobRunId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand("JobRunId"));
export type JobRunId = typeof JobRunId.Type;

export const JobRunIdFromString = Schema.String.check(
  Schema.isPattern(/^[1-9]\d*$/),
).pipe(Schema.decodeTo(Schema.NumberFromString), Schema.decodeTo(JobRunId));

export const JobRunReference = Schema.Struct({ id: JobRunId });

export const JobRunState = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);
export type JobRunState = typeof JobRunState.Type;

export const JobRunSummary = Schema.Struct({
  id: JobRunId,
  state: JobRunState,
  startedAt: Schema.NullOr(Schema.Int),
  endedAt: Schema.NullOr(Schema.Int),
  requestedBy: Schema.NullOr(Schema.NonEmptyString),
});
export type JobRunSummary = typeof JobRunSummary.Type;

export const jobSubmission = <Input extends Schema.Top>(input: Input) =>
  Schema.Struct({ input, requestId: Id });

export const jobRun = <Input extends Schema.Top>(input: Input) =>
  Schema.Struct({
    ...JobRunSummary.fields,
    input: Schema.NullOr(input),
    reason: Schema.NullOr(Schema.String),
    reasonCode: Schema.optionalKey(Schema.Literal("permission_denied")),
  });

export const localRunSchema = <Input extends Schema.Top>(input: Input) =>
  Schema.Struct({ id: JobRunId, input, completedAt: Schema.String });
