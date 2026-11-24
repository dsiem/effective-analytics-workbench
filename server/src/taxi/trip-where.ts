import type { DatabricksClient } from "@dsiem/sql-warehouse";
import type { Filters } from "../../../shared/filters.js";

export const tripWhere = (
  sql: DatabricksClient.DatabricksClient,
  filters: Filters,
) => sql`WHERE 1 = 1
      ${filters.from ? sql`AND tpep_pickup_datetime >= CAST(${filters.from} AS TIMESTAMP)` : sql``}
      ${filters.to ? sql`AND tpep_pickup_datetime < CAST(${filters.to} AS TIMESTAMP) + INTERVAL 1 DAY` : sql``}
      ${filters.zip ? sql`AND CAST(pickup_zip AS STRING) = ${filters.zip}` : sql``}`;
