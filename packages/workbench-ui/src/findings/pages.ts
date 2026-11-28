import { Effect } from "effect";

type Page<Row, Cursor> = {
  readonly rows: readonly Row[];
  readonly nextCursor: Cursor | null;
};

export function readFindingPages<Row, Cursor, E, R>(
  options: { readonly cursor: Cursor | null; readonly pages: number },
  fetch: (cursor: Cursor | null) => Effect.Effect<Page<Row, Cursor>, E, R>,
) {
  return Effect.gen(function* () {
    const rows: Row[] = [];
    let cursor = options.cursor;
    for (let index = 0; index < options.pages; index++) {
      const page = yield* fetch(cursor);
      rows.push(...page.rows);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    return { rows, nextCursor: cursor };
  });
}

export const mergeFindingPages = <Row extends { readonly id: string }>(
  previous: readonly Row[],
  next: readonly Row[],
) => [...new Map([...previous, ...next].map((row) => [row.id, row])).values()];
