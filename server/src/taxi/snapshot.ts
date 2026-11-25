import { Effect, Option } from "effect";
import type { DatabricksClient } from "@dsiem/sql-warehouse";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { unavailable } from "../errors.js";
import type { Warehouse } from "../warehouse.js";

export const taxiQueryUnavailable = (cause?: unknown) =>
  unavailable(
    "warehouse",
    "The NYC taxi query failed. Check warehouse access and SELECT permission on the configured trip snapshot.",
    cause,
  );

export const makeTaxiSnapshot = (
  warehouse: typeof Warehouse.Service,
  tripSnapshotTable: string,
) => {
  const [catalog, schema, table] = tripSnapshotTable.split(".");
  if (Option.isNone(warehouse) || !catalog || !schema || !table)
    return Effect.fail(
      unavailable(
        "warehouse",
        "Set DATABRICKS_WAREHOUSE_ID and TRIP_SNAPSHOT_TABLE to connect the NYC taxi dataset.",
      ),
    );

  const { sql, queries } = warehouse.value;
  return Effect.succeed({
    sql,
    snapshot: sql`${sql(catalog)}.${sql(schema)}.${sql(table)}`,
    ...queries({
      deniedMessage:
        "These trips are under lock. You need permission to read trip data.",
      unavailable: taxiQueryUnavailable,
    }),
  });
};

export type TaxiSnapshot = ReturnType<typeof makeTaxiSnapshot>;

export const tripWhere = (
  sql: DatabricksClient.DatabricksClient,
  filters: Filters,
) => sql`WHERE 1 = 1
      ${filters.from ? sql`AND tpep_pickup_datetime >= CAST(${filters.from} AS TIMESTAMP)` : sql``}
      ${filters.to ? sql`AND tpep_pickup_datetime < CAST(${filters.to} AS TIMESTAMP) + INTERVAL 1 DAY` : sql``}
      ${filters.zip ? sql`AND CAST(pickup_zip AS STRING) = ${filters.zip}` : sql``}`;
