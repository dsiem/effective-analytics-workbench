import {
  RecordViewport,
  recordWindow,
} from "@dsiem/workbench-ui/record-explorer";
import { Dialog, Menu } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";
import { TripCommentCounts } from "@dsiem/analytics-shared/trip-comments";
import { TripSort } from "@dsiem/analytics-shared/trips";
import { records, inspection } from "./records";
import { Notice } from "../../lib/request-state";

export const Sort = TripSort;
export const SortMenu = Menu.create<typeof Sort.Type>();
export const TripViewport = RecordViewport;
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
  ...records.Model.fields,
  ...inspection.Model.fields,
  sortMenu: Menu.Model,
  viewport: Schema.Option(TripViewport),
  commentCounts: CommentCounts,
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
  ...records.init(),
  ...inspection.init(),
  sortMenu: Menu.init({ id: "trip-sort-menu" }),
  viewport: Option.none(),
  commentCounts: emptyCommentCounts(0),
});
