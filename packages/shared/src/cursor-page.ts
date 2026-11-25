import { Schema } from "effect";

export const CursorTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  Schema.makeFilter(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === `${value.slice(0, 23)}Z`,
  ),
);

export const CursorPage = <Row extends Schema.Top, Cursor extends Schema.Top>(
  row: Row,
  cursor: Cursor,
) =>
  Schema.Struct({
    rows: Schema.Array(row),
    nextCursor: Schema.NullOr(cursor),
  });

/** Fetch one extra row to detect continuation. The cursor keeps the stored sort values. */
export function pageWindow(pageSize: number) {
  return {
    fetchLimit: pageSize + 1,
    fromRows<Stored, Row, Cursor>(
      results: readonly Stored[],
      project: {
        readonly row: (stored: Stored) => Row;
        readonly cursor: (stored: Stored) => Cursor;
      },
    ) {
      const visible = results.slice(0, pageSize);
      const last = visible.at(-1);
      return {
        rows: visible.map(project.row),
        nextCursor:
          results.length > pageSize && last !== undefined
            ? project.cursor(last)
            : null,
      };
    },
  };
}
