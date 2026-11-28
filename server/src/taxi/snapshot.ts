import { Effect, Option } from "effect";
import { dataset } from "@dsiem/analytics";
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
  const snapshot = sql`${sql(catalog)}.${sql(schema)}.${sql(table)}`;
  const source = dataset(sql, {
    table: snapshot,
    predicates: ({ from, to, zip }: Filters) => [
      from !== undefined &&
        sql`tpep_pickup_datetime >= CAST(${from} AS TIMESTAMP)`,
      to !== undefined &&
        sql`tpep_pickup_datetime < CAST(${to} AS TIMESTAMP) + INTERVAL 1 DAY`,
      zip !== undefined && sql`CAST(pickup_zip AS STRING) = ${zip}`,
    ],
  });
  return Effect.succeed({
    sql,
    source,
    ...queries({
      deniedMessage:
        "These trips are under lock. You need permission to read trip data.",
      unavailable: taxiQueryUnavailable,
    }),
  });
};

export type TaxiSnapshot = ReturnType<typeof makeTaxiSnapshot>;
