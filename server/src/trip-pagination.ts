import { Schema, Struct } from "effect";
import type { Fragment } from "effect/sql/Statement";
import type { DatabricksClient } from "@dsiem/sql-warehouse";
import { pageWindow } from "../../shared/cursor-page.js";
import {
  Trip,
  TripDetails,
  TripPosition,
  tripPageSize,
  type TripCursor,
  type Trips,
} from "../../shared/trips.js";

type Sql = DatabricksClient.DatabricksClient;
type SortKey = Exclude<keyof TripPosition, "trip_id">;
const page = pageWindow(tripPageSize);
export const tripZip = (sql: Sql, key: "pickup_zip" | "dropoff_zip") =>
  sql`COALESCE(CAST(${sql(key)} AS STRING), 'Unknown')`;
const timeKeys: readonly SortKey[] = ["pickup_at", "dropoff_at"];
const ascendingKeys: readonly SortKey[] = [
  "pickup_zip",
  "dropoff_zip",
  "fare",
  "distance",
];

function cursorValue(sql: Sql, key: SortKey, value: string | number) {
  if (key === "pickup_at" || key === "dropoff_at")
    return sql`CAST(${value} AS TIMESTAMP_NTZ)`;
  if (typeof value === "number") return sql.param("DOUBLE", String(value));
  return sql`${value}`;
}

export function tripPageWindow(
  sql: Sql,
  sort: TripCursor["sort"],
  after?: TripPosition,
) {
  const columns = {
    pickup_at: sql`tpep_pickup_datetime`,
    dropoff_at: sql`tpep_dropoff_datetime`,
    pickup_zip: tripZip(sql, "pickup_zip"),
    dropoff_zip: tripZip(sql, "dropoff_zip"),
    fare: sql`fare_amount`,
    distance: sql`trip_distance`,
  } satisfies Record<SortKey, Fragment>;
  const descending: readonly SortKey[] =
    sort === "newest" ? timeKeys : [sort, ...timeKeys];
  const keys = [...descending, ...ascendingKeys.filter((key) => key !== sort)];
  const order = keys.map((key) =>
    descending.includes(key)
      ? sql`${columns[key]} DESC NULLS LAST`
      : sql`${columns[key]} ASC NULLS FIRST`,
  );
  const window = sql`ORDER BY ${sql.csv([...order, sql`trip_id ASC`])} LIMIT ${sql.param("INT", String(page.fetchLimit))}`;
  if (!after) return window;

  // At the first unequal key the row must sort later. The unique ID breaks a complete tie.
  let seek: Fragment = sql`trip_id > ${after.trip_id}`;
  for (const key of keys.toReversed()) {
    const column = columns[key];
    const value = after[key];
    if (value === null) {
      const tied = sql`(${column} IS NULL AND ${seek})`;
      seek = descending.includes(key)
        ? tied
        : sql`(${column} IS NOT NULL OR ${tied})`;
    } else {
      const bound = cursorValue(sql, key, value);
      const later = descending.includes(key)
        ? sql`(${column} < ${bound} OR ${column} IS NULL)`
        : sql`${column} > ${bound}`;
      seek = sql`(${later} OR (${column} = ${bound} AND ${seek}))`;
    }
  }
  return sql`AND ${seek} ${window}`;
}

export const WarehouseTrip = Schema.Struct({
  ...Trip.fields,
  ...TripPosition.fields,
  details: Schema.fromJsonString(TripDetails),
});
const positionKeys = Struct.keys(TripPosition.fields);

export function formatTripPage(
  rows: readonly (typeof WarehouseTrip.Type)[],
  total: number,
  scope: Pick<TripCursor, "sort" | "filters">,
): typeof Trips.Type {
  return {
    ...page.fromRows(rows, {
      row: (trip) => ({
        ...trip,
        distance: trip.distance ?? 0,
        fare: trip.fare ?? 0,
      }),
      cursor: (trip) => ({ ...scope, after: Struct.pick(trip, positionKeys) }),
    }),
    total,
    pageSize: tripPageSize,
  };
}
