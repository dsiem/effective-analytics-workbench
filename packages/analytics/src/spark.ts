import type { Constructor, Fragment } from "effect/sql/Statement";
import type { Dataset, Expression } from "./index.js";

type SparkSql = Constructor & {
  readonly param: (type: "INT", value: string) => Fragment;
};

const geometry = [
  "id",
  "longitude",
  "latitude",
  "boundary",
  "total_cells",
] as const;
const reserved = new Set<string>(["cell", ...geometry]);

export function h3Cells<
  Filters,
  Measures extends Readonly<Record<string, Expression>>,
>(
  sql: SparkSql,
  source: Dataset<Filters>,
  options: {
    readonly filters: Filters;
    readonly where: Fragment;
    readonly longitude: Expression;
    readonly latitude: Expression;
    readonly resolution: number;
    readonly measures: Measures;
    readonly rankBy: {
      readonly measure: Extract<keyof Measures, string>;
      readonly direction: "asc" | "desc";
    };
    readonly limit: number;
  },
) {
  const { resolution, limit, rankBy } = options;
  if (!Number.isInteger(resolution) || resolution < 0 || resolution > 15)
    throw new RangeError("Expected an H3 resolution between 0 and 15");
  if (!Number.isInteger(limit) || limit < 1 || limit > 2_147_483_647)
    throw new RangeError("Expected a positive INT cell limit");
  const names = Object.keys(options.measures);
  if (names.some((name) => reserved.has(name.toLowerCase())))
    throw new TypeError("An H3 measure name conflicts with a cell field");
  if (!Object.hasOwn(options.measures, rankBy.measure))
    throw new TypeError("Rank cells by a selected measure");

  const bins = source.aggregate({
    filters: options.filters,
    where: options.where,
    dimensions: {
      cell: sql`h3_longlatash3(${options.longitude}, ${options.latitude}, ${sql.param("INT", String(resolution))})`,
    },
    measures: options.measures,
  });
  const rank = sql(rankBy.measure);
  const order =
    rankBy.direction === "asc" ? sql`${rank} ASC` : sql`${rank} DESC`;
  return sql<
    Record<(typeof geometry)[number] | Extract<keyof Measures, string>, unknown>
  >`
    SELECT h3_h3tostring(cell) AS id,
      (h3_centerasgeojson(cell):coordinates[0])::DOUBLE AS longitude,
      (h3_centerasgeojson(cell):coordinates[1])::DOUBLE AS latitude,
      h3_boundaryasgeojson(cell) AS boundary,
      ${sql.csv(names.map((name) => sql`${sql(name)}`))},
      COUNT(*) OVER()::DOUBLE AS total_cells
    FROM (${bins}) AS bins ORDER BY ${order}, cell LIMIT ${sql.param("INT", String(limit))}`;
}
