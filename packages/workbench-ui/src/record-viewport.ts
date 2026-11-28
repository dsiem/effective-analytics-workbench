import { Effect, Queue, Schema, Stream } from "effect";
import { Mount } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

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
  initialRowHeight = 44,
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
    rowHeight: viewport?.rowHeight ?? initialRowHeight,
  };
}

const M = defineMessageUnion({
  Measured: { viewport: RecordViewport, generation: Schema.Int },
});

const rowSelector = "tr[aria-rowindex]";
type Scrolled = ReturnType<typeof M.Measured>;

const RecordsViewport = Mount.defineStream("RecordsViewport", {
  args: {
    generation: Schema.Int,
    fixedRowHeight: Schema.NullOr(Schema.Number),
  },
  messages: [M.Measured],
  execute: ({ element, viewStateChanges, generation, fixedRowHeight }) =>
    Stream.callback<Scrolled>((queue) =>
      Effect.gen(function* () {
        if (!(element instanceof HTMLElement)) return;
        const header = element.querySelector("thead");
        const body = element.querySelector("tbody");
        if (!header || !body) return;

        let live = false;
        let last: Scrolled["viewport"] | undefined;
        const report = () => {
          if (!live) return;
          element.toggleAttribute(
            "data-scrollable-columns",
            element.scrollWidth - element.clientWidth > 1,
          );
          element.toggleAttribute(
            "data-more-columns",
            element.scrollWidth - element.clientWidth - element.scrollLeft > 1,
          );
          const rowHeight =
            fixedRowHeight ??
            body.querySelector(rowSelector)?.getBoundingClientRect().height ??
            0;
          if (rowHeight <= 0) return;
          const top = Math.max(0, element.scrollTop) / rowHeight;
          const bottom =
            top +
            Math.max(
              0,
              element.clientHeight - header.getBoundingClientRect().height,
            ) /
              rowHeight;
          const firstRow = Math.floor(top);
          const visibleEnd = Math.ceil(bottom);
          const pixelInRows = 1 / rowHeight;
          const fullStart = Math.ceil(top - pixelInRows);
          const fullEnd = Math.floor(bottom + pixelInRows);
          const tabStart =
            fullStart < fullEnd ? fullStart : Math.floor((top + bottom) / 2);
          const tabEnd = Math.max(fullEnd, tabStart + 1);

          const focusedRow =
            element.ownerDocument.activeElement?.closest(rowSelector);
          if (focusedRow && element.contains(focusedRow)) {
            const index = Number(focusedRow.getAttribute("aria-rowindex")) - 2;
            if (index < tabStart || index >= tabEnd)
              element.focus({ preventScroll: true });
          }

          if (
            last?.firstRow === firstRow &&
            last.visibleEnd === visibleEnd &&
            last.tabStart === tabStart &&
            last.tabEnd === tabEnd &&
            last.rowHeight === rowHeight
          )
            return;
          last = { firstRow, visibleEnd, tabStart, tabEnd, rowHeight };
          Queue.offerUnsafe(queue, M.Measured({ viewport: last, generation }));
        };

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const observer = new ResizeObserver(report);
            observer.observe(element);
            observer.observe(header);
            observer.observe(body);
            element.addEventListener("scroll", report, { passive: true });
            return observer;
          }),
          (observer) =>
            Effect.sync(() => {
              observer.disconnect();
              element.removeEventListener("scroll", report);
            }),
        );
        yield* Stream.runForEach(viewStateChanges, (state) =>
          Effect.sync(() => {
            live = state === "Live";
            last = undefined;
            report();
          }),
        );
      }),
    ),
});

export const recordViewportMount = <Message>(
  generation: number,
  measured: (value: {
    viewport: typeof RecordViewport.Type;
    generation: number;
  }) => Message,
  fixedRowHeight: number | null = null,
) =>
  Mount.mapMessage(
    RecordsViewport({ generation, fixedRowHeight }),
    ({ generation, viewport }) => measured({ generation, viewport }),
  );
