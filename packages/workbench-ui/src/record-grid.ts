import type { recordWindow } from "./record-viewport.js";
import type { Attribute } from "foldkit/html";
import type { Child, H } from "./primitives.js";

export function recordGrid<Message, Row>(
  h: H<Message>,
  rows: readonly Row[],
  options: {
    readonly caption: string;
    readonly headers: readonly Child[];
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
              ...(window ? rows.slice(start, end) : rows).map((row, offset) => {
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
