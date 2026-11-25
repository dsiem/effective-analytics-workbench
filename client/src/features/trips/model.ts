import { Dialog, Menu } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import { Filters } from "@dsiem/analytics-shared/filters";
import {
  TripCommentCounts,
  TripCommentCursor,
  TripCommentInput,
  TripComments,
} from "@dsiem/analytics-shared/trip-comments";
import { Trip, TripSort, TripSummary } from "@dsiem/analytics-shared/trips";
import { Notice } from "../../lib/request-state";

export const Sort = TripSort;
export const SortMenu = Menu.create<typeof Sort.Type>();
export const TripQuery = Schema.Struct({ filters: Filters, sort: Sort });
const PreviewRows = Schema.Array(TripSummary);
export const TripPreview = defineTaggedUnion({
  Idle: {},
  Loading: { query: TripQuery, rows: PreviewRows },
  Ready: { rows: PreviewRows, hasMore: Schema.Boolean },
  Failed: { rows: PreviewRows, error: Notice },
});
export const TripViewport = Schema.Struct({
  firstRow: Schema.Int,
  visibleEnd: Schema.Int,
  tabStart: Schema.Int,
  tabEnd: Schema.Int,
  rowHeight: Schema.Number,
});
const CommentRead = Schema.Struct({ cursor: Schema.Option(TripCommentCursor) });
const Inspector = Schema.Struct({
  trip: TripSummary,
  details: AsyncData.Schema(Trip, Notice).schema,
  comments: Schema.Struct({
    data: Schema.Option(TripComments),
    error: Notice,
    read: Schema.Option(CommentRead),
  }),
});
const CommentDraft = Schema.Union([
  Schema.Struct({
    state: Schema.Literals(["editing", "posting"]),
    body: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("retry"),
    ...TripCommentInput.fields,
  }),
]);
export const CommentCountPhase = defineTaggedUnion({
  Idle: {},
  Loading: { previousError: Schema.Option(Notice) },
  Failed: { error: Notice },
});
const CommentCounts = Schema.Struct({
  data: TripCommentCounts,
  version: Schema.Int,
  phase: CommentCountPhase,
});
export const emptyCommentCounts = (
  version: number,
): typeof CommentCounts.Type => ({
  version,
  data: {},
  phase: CommentCountPhase.Idle(),
});
export const Model = Schema.Struct({
  inspectorDialog: Dialog.Model,
  preview: TripPreview,
  sortMenu: Menu.Model,
  loadGeneration: Schema.Int,
  viewport: Schema.Option(TripViewport),
  inspector: Schema.Option(Inspector),
  detailLoadGeneration: Schema.Int,
  commentLoadGeneration: Schema.Int,
  commentCounts: CommentCounts,
  commentDrafts: Schema.Record(Schema.String, CommentDraft),
  postingTripId: Schema.Option(TripSummary.fields.trip_id),
  postError: Notice,
  posted: Schema.String,
});

export type Model = typeof Model.Type;
export const previewRows = (preview: Model["preview"]) =>
  preview._tag === "Idle" ? [] : preview.rows;

const initialTripRowHeight = 44;
const tripWindowSize = 25;
const leadingOverscan = 3;
const windowStep = 8;

export function tripWindow(rowCount: number, selection: Model["viewport"]) {
  const viewport = Option.getOrUndefined(selection);
  const firstRow = viewport?.firstRow ?? 0;
  const size = Math.max(
    tripWindowSize,
    (viewport?.visibleEnd ?? 0) - firstRow + leadingOverscan + windowStep - 1,
  );
  const start = Math.max(
    0,
    Math.min(
      rowCount - size,
      Math.floor((firstRow - leadingOverscan) / windowStep) * windowStep,
    ),
  );
  const end = Math.min(rowCount, start + size);
  return {
    start,
    end,
    visibleStart: firstRow,
    visibleEnd: Math.min(rowCount, viewport?.visibleEnd ?? 0),
    tabStart: viewport?.tabStart ?? 0,
    tabEnd: Math.min(rowCount, viewport?.tabEnd ?? 0),
    rowHeight: viewport?.rowHeight ?? initialTripRowHeight,
  };
}

export const init = (): Model => ({
  inspectorDialog: Dialog.init({
    id: "trip-details",
    focusSelector: "#trip-details-dialog-title",
  }),
  preview: TripPreview.Idle(),
  sortMenu: Menu.init({ id: "trip-sort-menu" }),
  loadGeneration: 0,
  viewport: Option.none(),
  inspector: Option.none(),
  detailLoadGeneration: 0,
  commentLoadGeneration: 0,
  commentCounts: emptyCommentCounts(0),
  commentDrafts: {},
  postingTripId: Option.none(),
  postError: "",
  posted: "",
});
