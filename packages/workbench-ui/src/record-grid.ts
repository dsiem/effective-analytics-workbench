import { Schema } from "effect";
import type { Attribute } from "foldkit/html";
import type { Child, H } from "./primitives.js";

export const RecordViewport = Schema.Struct({
  firstRow: Schema.Int,
  visibleEnd: Schema.Int,
  tabStart: Schema.Int,
  tabEnd: Schema.Int,
  rowHeight: Schema.Number,
});

export function recordWindow(
  rowCount: number,
  viewport?: typeof RecordViewport.Type,
) {
  const firstRow = viewport?.firstRow ?? 0;
  const leadingOverscan = 3;
  const windowStep = 8;
  const minimumRows = 25;
  const size = Math.max(
    minimumRows,
    (viewport?.visibleEnd ?? 0) - firstRow + leadingOverscan + windowStep - 1,
  );
  const start = Math.max(
    0,
    Math.min(
      rowCount - size,
      Math.floor((firstRow - leadingOverscan) / windowStep) * windowStep,
    ),
  );
  return {
    start,
    end: Math.min(rowCount, start + size),
    visibleStart: firstRow,
    visibleEnd: Math.min(rowCount, viewport?.visibleEnd ?? 0),
    tabStart: viewport?.tabStart ?? 0,
    tabEnd: Math.min(rowCount, viewport?.tabEnd ?? 0),
    rowHeight: viewport?.rowHeight ?? 44,
  };
}

export function recordGrid<Message, Row>(
  h: H<Message>,
  rows: readonly Row[],
  options: {
    readonly caption: string;
    readonly headers: readonly string[];
    readonly key: (row: Row) => string;
    readonly cells: (row: Row, tabbable: boolean) => readonly Child[];
    readonly region?: readonly Attribute<Message>[];
    readonly window?: ReturnType<typeof recordWindow>;
    readonly loading?: boolean;
  },
) {
  const { caption, headers, cells, window } = options;
  const start = window?.start ?? 0;
  const end = window?.end ?? rows.length;
  const spacer = (count: number, key: string) =>
    count && window
      ? [
          h.tr(
            [h.Key(key), h.AriaHidden(true), h.Class("record-spacer")],
            [
              h.td(
                [
                  h.Colspan(headers.length),
                  h.Style({ height: `${count * window.rowHeight}px` }),
                ],
                [],
              ),
            ],
          ),
        ]
      : [];
  return h.div(
    [h.Class("table-scroll"), ...(options.region ?? [])],
    [
      h.table(
        [h.AriaRowcount(options.loading ? -1 : rows.length + 1)],
        [
          h.caption([h.Class("sr-only")], [caption]),
          h.thead(
            [],
            [
              h.tr(
                [],
                headers.map((label) => h.th([h.Scope("col")], [label])),
              ),
            ],
          ),
          h.tbody(
            [],
            [
              ...spacer(start, "before"),
              ...rows.slice(start, end).map((row, offset) => {
                const index = start + offset;
                const tabbable =
                  !window ||
                  (index >= window.tabStart && index < window.tabEnd);
                return h.tr(
                  [h.Key(options.key(row)), h.AriaRowindex(index + 2)],
                  cells(row, tabbable).map((cell) => h.td([], [cell])),
                );
              }),
              ...spacer(rows.length - end, "after"),
            ],
          ),
        ],
      ),
    ],
  );
}
