import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import {
  JobRunId,
  type JobRunState,
  type JobRunSummary,
} from "./contracts/job-runs.js";
import {
  JobReportPending,
  JobRunNotFound,
  InvalidRequest,
  permissionDenied,
  UpstreamError,
  unavailable,
} from "./errors.js";
import type { SqlClient } from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Expression } from "./index.js";

export interface JobTransport<E, R = never> {
  readonly request: (
    path: string,
    method?: "GET" | "POST",
    body?: unknown,
  ) => Effect.Effect<unknown, E, R>;
  readonly statusOf: (failure: E) => number | undefined;
}

const Run = Schema.Struct({
  job_id: Schema.Int,
  run_id: JobRunId,
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
const Started = Schema.Struct({ run_id: JobRunId });
const jobs = "/api/2.2/jobs";
const historyLimit = 10;

const terminationCode = (run: Run) =>
  run.state?.result_state === "TIMEDOUT"
    ? "TIMEDOUT"
    : (run.status?.termination_details?.code ?? run.state?.result_state);

const runState = (run: Run): JobRunState => {
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
      return "This run stopped early. It needs permission to complete the job.";
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

const summary = (run: Run, requestedBy: string | null): JobRunSummary => ({
  id: run.run_id,
  state: runState(run),
  startedAt: run.start_time || null,
  endedAt: run.end_time || null,
  requestedBy,
});

const notFound = () =>
  new JobRunNotFound({ message: "This job run could not be found." });

type JobParameters = Readonly<Record<string, string>> & {
  readonly requested_by?: never;
};

export interface JobDefinition<Input, Report, E = never, R = never> {
  readonly jobId: number | null;
  readonly parameters: Schema.Codec<Input, JobParameters>;
  readonly readReport: (
    id: JobRunId,
  ) => Effect.Effect<Option.Option<Report>, E, R>;
}

export const bindJob = <Input, Report, E, R, RequestError, RequestServices>(
  { request, statusOf }: JobTransport<RequestError, RequestServices>,
  { jobId, parameters, readReport }: JobDefinition<Input, Report, E, R>,
) => {
  const jobConfigured =
    jobId !== null
      ? Effect.void
      : Effect.fail(unavailable("jobs", "Configure the job ID."));
  const decodeInput = Schema.decodeUnknownOption(parameters);
  const encodeInput = Schema.encodeEffect(parameters);

  const requestRun = (
    path: string,
    denied: string,
    method?: "GET" | "POST",
    body?: unknown,
  ) =>
    request(path, method, body).pipe(
      Effect.mapError((error) =>
        statusOf(error) === 403 ? permissionDenied(denied) : error,
      ),
    );

  const decode =
    <A>(schema: Schema.Decoder<A>) =>
    (value: unknown) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(
          (cause) =>
            new UpstreamError({
              service: "jobs",
              message: "Databricks returned an unexpected job run response.",
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
        return requestRun(
          `${jobs}/run-now`,
          "You need permission to start this job.",
          "POST",
          {
            job_id: jobId,
            job_parameters: { ...values, requested_by: requestedBy ?? "" },
            idempotency_token: token,
          },
        );
      }),
      Effect.flatMap(decode(Started)),
      Effect.map(({ run_id: id }) => ({ id })),
    );

  const list = jobConfigured.pipe(
    Effect.andThen(
      requestRun(
        `${jobs}/runs/list?job_id=${jobId}&limit=${historyLimit}`,
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

  const lookup = (id: JobRunId) =>
    jobConfigured.pipe(
      Effect.andThen(
        request(
          `${jobs}/runs/get?run_id=${id}&include_resolved_values=true`,
        ).pipe(
          Effect.mapError((error) => {
            switch (statusOf(error)) {
              case 404:
                return notFound();
              case 403:
                return permissionDenied(
                  "This run is under lock. You need permission to open it.",
                );
              default:
                return error;
            }
          }),
        ),
      ),
      Effect.flatMap(decode(Run)),
      Effect.filterOrFail(
        (run) => run.job_id === jobId && run.run_id === id,
        notFound,
      ),
    );

  const get = (id: JobRunId) =>
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

  const result = (id: JobRunId) =>
    lookup(id).pipe(
      Effect.filterOrFail(
        (run) => runState(run) === "succeeded",
        () =>
          new JobReportPending({
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
                "jobs",
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
  (id: JobRunId) =>
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
