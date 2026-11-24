import { createHash } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  AnalysisInput,
  AnalysisRun,
  AnalysisRunId,
  type AnalysisRunState,
  type AnalysisRunSummary,
  type AnalysisSubmission,
  RouteReliabilityReport,
} from "../../shared/analysis-runs.js";
import {
  AnalysisReportPending,
  AnalysisRunNotFound,
  mapWorkspacePermission,
  UpstreamError,
  unavailable,
} from "./errors.js";
import { Settings } from "./settings.js";
import { Warehouse } from "./warehouse.js";
import { Workspace } from "./workspace.js";

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

const parameter = (run: Run, name: string) => {
  const entry = run.job_parameters?.find((entry) => entry.name === name);
  return entry?.value ?? entry?.default;
};

const submittedInput = (run: Run) =>
  Option.getOrNull(
    Schema.decodeUnknownOption(AnalysisInput)({
      baselineWeek: parameter(run, "baseline_week"),
      comparisonWeek: parameter(run, "comparison_week"),
      minimumTrips: Number(parameter(run, "minimum_trips")),
    }),
  );

const summary = (run: Run): AnalysisRunSummary => ({
  id: run.run_id,
  state: runState(run),
  startedAt: run.start_time || null,
  endedAt: run.end_time || null,
  requestedBy: parameter(run, "requested_by")?.trim() || null,
});

const notFound = () =>
  new AnalysisRunNotFound({ message: "This analysis run could not be found." });

const makeAnalysisRuns = Effect.gen(function* () {
  const { analysisJobId, analysisResultsTable, tripSnapshotTable } =
    yield* Settings;
  const workspace = yield* Workspace;
  const warehouse = yield* Warehouse;
  const configured =
    analysisJobId &&
    analysisResultsTable &&
    tripSnapshotTable &&
    Option.isSome(warehouse)
      ? Effect.succeed(warehouse.value)
      : Effect.fail(
          unavailable(
            "analysis",
            "Analysis runs are unavailable. Connect the analysis job, warehouse, and results table in the app configuration.",
          ),
        );

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
    { input, requestId }: typeof AnalysisSubmission.Type,
    requestedBy: string | null,
  ) => {
    const { baselineWeek, comparisonWeek, minimumTrips } = input;
    const parameters = {
      baseline_week: baselineWeek,
      comparison_week: comparisonWeek,
      minimum_trips: String(minimumTrips),
    };
    const token = createHash("sha256")
      .update(JSON.stringify([analysisJobId, requestId, parameters]))
      .digest("hex");
    return configured.pipe(
      Effect.andThen(
        workspace.request(`${jobs}/run-now`, "POST", {
          job_id: analysisJobId,
          job_parameters: { ...parameters, requested_by: requestedBy ?? "" },
          idempotency_token: token,
        }),
      ),
      Effect.mapError(
        mapWorkspacePermission(
          "This run needs a green light. Starting an analysis requires permission.",
        ),
      ),
      Effect.flatMap(decode(Started)),
      Effect.map(({ run_id: id }) => ({ id })),
    );
  };

  const list = configured.pipe(
    Effect.andThen(
      workspace.request(
        `${jobs}/runs/list?job_id=${analysisJobId}&limit=${historyLimit}`,
      ),
    ),
    Effect.mapError(
      mapWorkspacePermission(
        "The run history is under lock. You need permission to browse it.",
      ),
    ),
    Effect.flatMap(decode(Runs)),
    Effect.map(({ runs }) =>
      (runs ?? [])
        .filter((run) => run.job_id === analysisJobId)
        .slice(0, historyLimit)
        .map(summary),
    ),
  );

  const lookup = (id: AnalysisRunId) =>
    configured.pipe(
      Effect.andThen(
        workspace.request(
          `${jobs}/runs/get?run_id=${id}&include_resolved_values=true`,
        ),
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
        (run) => run.job_id === analysisJobId && run.run_id === id,
        notFound,
      ),
    );

  const get = (id: AnalysisRunId) =>
    lookup(id).pipe(
      Effect.map((run): typeof AnalysisRun.Type => {
        const details = summary(run);
        return {
          ...details,
          input: submittedInput(run),
          ...(details.state === "failed" &&
          terminationCode(run) === "UNAUTHORIZED_ERROR"
            ? { reasonCode: "permission_denied" }
            : {}),
          reason: details.state === "failed" ? failureReason(run) : null,
        };
      }),
    );

  const readReport = (id: AnalysisRunId) =>
    Effect.gen(function* () {
      const { sql, queries } = yield* configured;
      const [catalog, schema, table] = analysisResultsTable.split(".");
      if (!catalog || !schema || !table)
        return yield* unavailable(
          "analysis",
          "Configure the analysis results table.",
        );

      const { read } = queries({
        deniedMessage:
          "This report is under lock. You need permission to read it.",
        unavailable: (cause) =>
          unavailable(
            "analysis",
            "The report could not be read. Check SELECT access to the results table.",
            cause,
          ),
      });
      const [row] = yield* read(
        Schema.Struct({
          report_json: Schema.fromJsonString(RouteReliabilityReport),
        }),
        sql`SELECT report_json FROM ${sql(catalog)}.${sql(schema)}.${sql(table)}
          WHERE run_id = CAST(${String(id)} AS BIGINT) LIMIT 1`,
      );
      return row
        ? row.report_json
        : yield* unavailable(
            "analysis",
            "The completed report is missing. Check the job's results table.",
          );
    });

  const result = (id: AnalysisRunId) =>
    lookup(id).pipe(
      Effect.filterOrFail(
        (run) => runState(run) === "succeeded",
        () =>
          new AnalysisReportPending({
            message: "The report is available after the run succeeds.",
          }),
      ),
      Effect.andThen(readReport(id)),
    );

  return { submit, list, get, result };
});

export class AnalysisRuns extends Context.Service<
  AnalysisRuns,
  Effect.Success<typeof makeAnalysisRuns>
>()("app/AnalysisRuns") {
  static readonly layer = Layer.effect(this, makeAnalysisRuns);
}
