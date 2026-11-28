import {
  RecordViewport,
  recordWindow,
} from "@dsiem/workbench-ui/record-explorer";
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
export const TripViewport = RecordViewport;
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

export const tripWindow = (rowCount: number, selection: Model["viewport"]) =>
  recordWindow(rowCount, Option.getOrUndefined(selection));

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
