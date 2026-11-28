import { Effect, Option, type Schema } from "effect";
import type { AnalysisRunId } from "@dsiem/analytics/contracts";
import { sqlJsonReport } from "@dsiem/analytics/jobs";
import { unavailable } from "../errors.js";
import type { Warehouse } from "../warehouse.js";

export const warehouseJsonReport =
  <Report>({
    warehouse,
    tableName,
    report,
  }: {
    readonly warehouse: typeof Warehouse.Service;
    readonly tableName: string;
    readonly report: Schema.Decoder<Report>;
  }) =>
  (id: AnalysisRunId) =>
    Effect.gen(function* () {
      if (Option.isNone(warehouse))
        return yield* unavailable(
          "analysis",
          "Configure the report warehouse.",
        );
      const { sql, queries } = warehouse.value;
      const [catalog, schema, table, extra] = tableName.split(".");
      if (!catalog || !schema || !table || extra !== undefined)
        return yield* unavailable(
          "analysis",
          "Configure the analysis results table.",
        );

      const { run } = queries({
        deniedMessage:
          "This report is under lock. You need permission to read it.",
        unavailable: (cause) =>
          unavailable(
            "analysis",
            "The report could not be read. Check SELECT access to the results table.",
            cause,
          ),
      });
      return yield* run(
        sqlJsonReport(
          sql,
          sql`${sql(catalog)}.${sql(schema)}.${sql(table)}`,
          report,
        )(id),
      );
    });
