import type { Constructor, Fragment, Identifier } from "effect/sql/Statement";

export type Expression = Fragment | Identifier;
type Fields = Readonly<Record<string, Expression>>;

interface Query<Filters> {
  readonly filters: Filters;
  /** Additional restriction for this analysis, combined with the dataset predicates. */
  readonly where?: Fragment;
  readonly orderBy?: readonly Fragment[];
  readonly limit?: number | Fragment;
}

export function dataset<Filters>(
  sql: Constructor,
  definition: {
    readonly table: Expression;
    readonly predicates: (
      filters: Filters,
    ) => readonly (Fragment | false | undefined)[];
  },
) {
  function where(filters: Filters, extra?: Fragment) {
    const conditions = [...definition.predicates(filters), extra].filter(
      (condition) => condition !== undefined && condition !== false,
    );
    return sql`WHERE ${sql.and(conditions.map((condition) => sql`(${condition})`))}`;
  }

  function projection(fields: Fields) {
    return Object.entries(fields).map(
      ([alias, expression]) => sql`${expression} AS ${sql(alias)}`,
    );
  }

  function select<Name extends string>(
    columns: readonly Fragment[],
    groups: readonly string[],
    query: Query<Filters>,
  ) {
    if (!columns.length) throw new TypeError("Select at least one field");
    if (
      typeof query.limit === "number" &&
      (!Number.isSafeInteger(query.limit) || query.limit < 0)
    )
      throw new RangeError("Expected a nonnegative integer limit");
    const limit =
      query.limit === undefined ? sql`` : sql` LIMIT ${query.limit}`;
    return sql<
      Record<Name, unknown>
    >`SELECT ${sql.csv(columns)} FROM ${definition.table}
      ${where(query.filters, query.where)} ${sql.csv("GROUP BY", groups)} ${sql.csv("ORDER BY", query.orderBy ?? [])}${limit}`;
  }

  function records<Columns extends Fields>(
    query: Query<Filters> & { readonly fields: Columns },
  ) {
    return select<Extract<keyof Columns, string>>(
      projection(query.fields),
      [],
      query,
    );
  }

  function aggregate<Measures extends Fields, Dimensions extends Fields = {}>(
    query: Query<Filters> & {
      readonly measures: Measures;
      readonly dimensions?: Dimensions;
    },
  ) {
    const dimensions = Object.keys(query.dimensions ?? {});
    if (dimensions.some((name) => Object.hasOwn(query.measures, name)))
      throw new TypeError("Dimension and measure names must be distinct");
    if (!Object.keys(query.measures).length)
      throw new TypeError("Select at least one measure");

    // Ordinals bind each group to its projected expression even if a source
    // column shares its alias or the expression itself contains parameters.
    const groups = dimensions.map((_, index) => String(index + 1));
    return select<Extract<keyof Measures | keyof Dimensions, string>>(
      [...projection(query.dimensions ?? {}), ...projection(query.measures)],
      groups,
      query,
    );
  }

  return { records, aggregate, where };
}

export type Dataset<Filters> = ReturnType<typeof dataset<Filters>>;
