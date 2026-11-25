import { Popover } from "@foldkit/ui";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import { SavedView, SavedViewsPage } from "@dsiem/analytics-shared/saved-views";
import { Notice } from "../../lib/request-state";

export const RecentIds = Schema.Array(SavedView.fields.id).check(
  Schema.isMaxLength(5),
);
export const PickerMode = defineTaggedUnion({
  Quick: {},
  Browse: {},
  Search: { query: Schema.String },
});
export const Shortcuts = Schema.Struct({
  rows: Schema.Array(SavedView),
  recents: Schema.Array(SavedView),
});
export const Model = Schema.Struct({
  savedViews: AsyncData.Schema(SavedViewsPage, Notice).schema,
  savedViewPages: Schema.Number,
  pickerMode: PickerMode,
  searchVersion: Schema.Number,
  shortcuts: AsyncData.Schema(Shortcuts, Notice).schema,
  shortcutVersion: Schema.Number,
  recentIds: RecentIds,
  picker: Popover.Model,
});
export type Model = typeof Model.Type;
export const init = (): Model => ({
  savedViews: AsyncData.Idle(),
  savedViewPages: 1,
  pickerMode: PickerMode.Quick(),
  searchVersion: 0,
  shortcuts: AsyncData.Idle(),
  shortcutVersion: 0,
  recentIds: [],
  picker: Popover.init({
    id: "saved-views-picker",
    contentFocus: true,
    isModal: true,
  }),
});
