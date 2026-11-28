import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import {
  AnalysisRunId,
  type AnalysisRunState,
  type AnalysisRunSummary,
} from "./contracts/job-runs.js";
import {
  AnalysisReportPending,
  AnalysisRunNotFound,
  InvalidRequest,
  mapWorkspacePermission,
  UpstreamError,
  unavailable,
} from "./errors.js";
import type { SqlClient } from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Expression } from "./index.js";

export type JobRequest<E = never, R = never> = (
  path: string,
  method?: "GET" | "POST",
  body?: unknown,
) => Effect.Effect<unknown, E, R>;

const Run = Schema.Struct({
  job_id: Schema.Int,
  run_id: AnalysisRunId,
  start_time: Schema.optionalKey(Schema.Int),
  end_time: Schema.optionalKey(Schema.Int),
  status: Schema.optionalKey(
    Schema.Struct({
      state: Schema.String,
      termination_details: Schema.optionalKey(
        Schema.Struct({ code: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
  state: Schema.optionalKey(
    Schema.Struct({
      life_cycle_state: Schema.String,
      result_state: Schema.optionalKey(Schema.String),
    }),
  ),
  job_parameters: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        value: Schema.optionalKey(Schema.String),
        default: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
type Run = typeof Run.Type;
const Runs = Schema.Struct({ runs: Schema.optionalKey(Schema.Array(Run)) });
const Started = Schema.Struct({ run_id: AnalysisRunId });
const jobs = "/api/2.2/jobs";
const historyLimit = 10;

const terminationCode = (run: Run) =>
  run.state?.result_state === "TIMEDOUT"
    ? "TIMEDOUT"
    : (run.status?.termination_details?.code ?? run.state?.result_state);

const runState = (run: Run): AnalysisRunState => {
  switch (run.status?.state ?? run.state?.life_cycle_state) {
    case "BLOCKED":
    case "PENDING":
    case "QUEUED":
    case "WAITING":
    case "WAITING_FOR_RETRY":
      return "queued";
    case "RUNNING":
    case "TERMINATING":
      return "running";
    case "TERMINATED":
      switch (terminationCode(run)) {
        case "SUCCESS":
          return "succeeded";
        case "CANCELED":
        case "CANCELLED":
        case "USER_CANCELED":
          return "canceled";
        case undefined:
          return "unknown";
        default:
          return "failed";
      }
    case "INTERNAL_ERROR":
    case "SKIPPED":
      return "failed";
    default:
      return "unknown";
  }
};

const failureReason = (run: Run) => {
  const code = terminationCode(run);
  switch (code) {
    case "UNAUTHORIZED_ERROR":
      return "This run stopped early. It needs permission to complete the analysis.";
    case "TIMED_OUT":
    case "TIMEDOUT":
      return "The Databricks run timed out.";
    case "MAX_JOB_QUEUE_SIZE_EXCEEDED":
    case "MAX_CONCURRENT_RUNS_EXCEEDED":
    case "MAXIMUM_CONCURRENT_RUNS_REACHED":
      return "The job reached its run or queue limit.";
    default:
      return code && /^[A-Z_0-9]{1,64}$/.test(code)
        ? `Databricks ended the run with ${code.toLowerCase().replaceAll("_", " ")}.`
        : "Databricks could not complete the run. Check the job run details in Databricks.";
  }
};

const parametersOf = (run: Run) => {
  const resolved = (run.job_parameters ?? []).flatMap(
    ({ name, value, default: fallback }) => {
      const parameter = value ?? fallback;
      return parameter === undefined ? [] : [[name, parameter] as const];
    },
  );
  const { requested_by, ...input } = Object.fromEntries(resolved);
  return { requestedBy: requested_by?.trim() || null, input };
};

const summary = (run: Run, requestedBy: string | null): AnalysisRunSummary => ({
  id: run.run_id,
  state: runState(run),
  startedAt: run.start_time || null,
  endedAt: run.end_time || null,
  requestedBy,
});

const notFound = () =>
  new AnalysisRunNotFound({ message: "This analysis run could not be found." });

type JobParameters = Readonly<Record<string, string>> & {
  readonly requested_by?: never;
};

export interface AnalysisJob<Input, Report, E = never, R = never> {
  readonly jobId: number | null;
  readonly parameters: Schema.Codec<Input, JobParameters>;
  readonly readReport: (
    id: AnalysisRunId,
  ) => Effect.Effect<Option.Option<Report>, E, R>;
}

export const makeAnalysisJob = <
  Input,
  Report,
  E,
  R,
  RequestError,
  RequestServices,
>(
  request: JobRequest<RequestError, RequestServices>,
  { jobId, parameters, readReport }: AnalysisJob<Input, Report, E, R>,
) => {
  const jobConfigured =
    jobId !== null
      ? Effect.void
      : Effect.fail(unavailable("analysis", "Configure the analysis job."));
  const decodeInput = Schema.decodeUnknownOption(parameters);
  const encodeInput = Schema.encodeEffect(parameters);

  const decode =
    <A>(schema: Schema.Decoder<A>) =>
    (value: unknown) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(
          (cause) =>
            new UpstreamError({
              service: "analysis",
              message:
                "Databricks returned an unexpected analysis run response.",
              cause,
            }),
        ),
      );

  const submit = (
    { input, requestId }: { readonly input: Input; readonly requestId: string },
    requestedBy: string | null,
  ) =>
    jobConfigured.pipe(
      Effect.andThen(
        encodeInput(input).pipe(
          Effect.mapError(
            (cause) =>
              new InvalidRequest({
                message: "The job parameters are invalid.",
                cause,
              }),
          ),
        ),
      ),
      Effect.filterOrFail(
        (values) => !Object.hasOwn(values, "requested_by"),
        () =>
          new InvalidRequest({
            message: "requested_by is reserved for viewer attribution.",
          }),
      ),
      Effect.flatMap((values) => {
        const ordered = Object.fromEntries(
          Object.keys(values)
            .sort()
            .map((key) => [key, values[key]]),
        );
        const token = createHash("sha256")
          .update(JSON.stringify([jobId, requestId, ordered]))
          .digest("hex");
        return request(`${jobs}/run-now`, "POST", {
          job_id: jobId,
          job_parameters: { ...values, requested_by: requestedBy ?? "" },
          idempotency_token: token,
        });
      }),
      Effect.mapError(
        mapWorkspacePermission(
          "This run needs a green light. Starting an analysis requires permission.",
        ),
      ),
      Effect.flatMap(decode(Started)),
      Effect.map(({ run_id: id }) => ({ id })),
    );

  const list = jobConfigured.pipe(
    Effect.andThen(
      request(`${jobs}/runs/list?job_id=${jobId}&limit=${historyLimit}`),
    ),
    Effect.mapError(
      mapWorkspacePermission(
        "The run history is under lock. You need permission to browse it.",
      ),
    ),
    Effect.flatMap(decode(Runs)),
    Effect.map(({ runs }) =>
      (runs ?? [])
        .filter((run) => run.job_id === jobId)
        .slice(0, historyLimit)
        .map((run) => summary(run, parametersOf(run).requestedBy)),
    ),
  );

  const lookup = (id: AnalysisRunId) =>
    jobConfigured.pipe(
      Effect.andThen(
        request(`${jobs}/runs/get?run_id=${id}&include_resolved_values=true`),
      ),
      Effect.mapError((error) =>
        error instanceof UpstreamError && error.upstreamStatus === 404
          ? notFound()
          : mapWorkspacePermission(
              "This run is under lock. You need permission to open it.",
            )(error),
      ),
      Effect.flatMap(decode(Run)),
      Effect.filterOrFail(
        (run) => run.job_id === jobId && run.run_id === id,
        notFound,
      ),
    );

  const get = (id: AnalysisRunId) =>
    lookup(id).pipe(
      Effect.map((run) => {
        const { requestedBy, input } = parametersOf(run);
        const details = summary(run, requestedBy);
        return {
          ...details,
          input: Option.getOrNull(decodeInput(input)),
          ...(details.state === "failed" &&
          terminationCode(run) === "UNAUTHORIZED_ERROR"
            ? { reasonCode: "permission_denied" as const }
            : {}),
          reason: details.state === "failed" ? failureReason(run) : null,
        };
      }),
    );

  const result = (id: AnalysisRunId) =>
    lookup(id).pipe(
      Effect.filterOrFail(
        (run) => runState(run) === "succeeded",
        () =>
          new AnalysisReportPending({
            message: "The report is available after the run succeeds.",
          }),
      ),
      Effect.flatMap(() => readReport(id)),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              unavailable(
                "analysis",
                "The completed report is missing. Check the job's results table.",
              ),
            ),
        }),
      ),
    );

  return { submit, list, get, result };
};

export const sqlJsonReport =
  <Report>(sql: SqlClient, table: Expression, report: Schema.Decoder<Report>) =>
  (id: AnalysisRunId) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ report_json: Schema.fromJsonString(report) }),
      execute: () => sql`SELECT report_json FROM ${table}
      WHERE run_id = CAST(${String(id)} AS BIGINT) LIMIT 1`,
    })(undefined).pipe(
      Effect.map(([row]) =>
        row ? Option.some(row.report_json) : Option.none(),
      ),
    );
