import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { AnalysisRunId, localRunSchema } from "./contracts/job-runs.js";
import { AnalysisRunNotFound, InvalidRequest } from "./errors.js";
import { sqlJsonReport } from "./jobs.js";

interface RunTable {
  readonly schema: string;
  readonly name: string;
}

export const initializeLocalRunTable = (sql: SqlClient, table: RunTable) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE SCHEMA IF NOT EXISTS ${sql(table.schema)}`;
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(table.schema)}.${sql(table.name)} (
      run_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id uuid NOT NULL UNIQUE, input_json jsonb NOT NULL,
      report_json text NOT NULL, completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`;
    }),
  );

/** Run a bounded calculation inside the transaction that commits its inputs and report. */
export function makeLocalRuns<
  Input,
  InputJson extends Schema.Json,
  Report,
  ReportJson extends Schema.Json,
  E,
  R,
>(
  sql: SqlClient,
  options: {
    readonly table: RunTable;
    readonly input: Schema.Codec<Input, InputJson>;
    readonly report: Schema.Codec<Report, ReportJson>;
    readonly calculate: (input: Input) => Effect.Effect<Report, E, R>;
  },
) {
  const target = sql`${sql(options.table.schema)}.${sql(options.table.name)}`;
  const run = localRunSchema(options.input);
  const columns = sql`run_id AS id, input_json AS input,
    to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt"`;
  const submit = ({
    input,
    requestId,
  }: {
    readonly input: Input;
    readonly requestId: string;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const encoded = JSON.stringify(
          yield* Schema.encodeEffect(options.input)(input),
        );
        // Serialize retries across transactions before doing any work for the request.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}::uuid::text, 0))`;
        const [existing] = yield* sql<{
          id: number;
          matches: boolean;
        }>`SELECT run_id AS id,
        input_json = ${encoded}::jsonb AS matches FROM ${target} WHERE request_id=${requestId}::uuid`;
        if (existing) {
          if (!existing.matches)
            return yield* new InvalidRequest({
              message:
                "This request ID already belongs to a run with different inputs.",
            });
          return {
            id: yield* Schema.decodeUnknownEffect(AnalysisRunId)(existing.id),
          };
        }
        const report = yield* options.calculate(input);
        const json = JSON.stringify(
          yield* Schema.encodeEffect(options.report)(report),
        );
        const [row] =
          yield* sql`INSERT INTO ${target} (request_id, input_json, report_json)
        VALUES (${requestId}::uuid, ${encoded}::jsonb, ${json}) RETURNING run_id AS id`;
        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({ id: AnalysisRunId }),
        )(row);
      }),
    );
  const list = SqlSchema.findAll({
    Request: Schema.Void,
    Result: run,
    execute: () =>
      sql`SELECT ${columns} FROM ${target} ORDER BY completed_at DESC, run_id DESC LIMIT 10`,
  })(undefined);
  const notFound = () =>
    new AnalysisRunNotFound({
      message: "This analysis run could not be found.",
    });
  const get = (id: AnalysisRunId) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: run,
      execute: () => sql`SELECT ${columns} FROM ${target} WHERE run_id=${id}`,
    })(undefined).pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : Effect.fail(notFound()),
      ),
    );
  const readReport = sqlJsonReport(sql, target, options.report);
  const result = (id: AnalysisRunId) =>
    readReport(id).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () => Effect.fail(notFound()),
        }),
      ),
    );
  return { submit, list, get, result };
}
