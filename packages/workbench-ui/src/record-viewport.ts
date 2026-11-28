import { Effect, Queue, Schema, Stream } from "effect";
import { Mount } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { RecordViewport } from "./record-grid.js";

const M = defineMessageUnion({
  Measured: { viewport: RecordViewport, generation: Schema.Int },
});

const rowSelector = "tr[aria-rowindex]";
type Scrolled = ReturnType<typeof M.Measured>;

const RecordsViewport = Mount.defineStream("RecordsViewport", {
  args: { generation: Schema.Int },
  messages: [M.Measured],
  execute: ({ element, viewStateChanges, generation }) =>
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
            "data-more-columns",
            element.scrollWidth - element.clientWidth - element.scrollLeft > 1,
          );
          const rowHeight =
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
) => Mount.mapMessage(RecordsViewport({ generation }), measured);
