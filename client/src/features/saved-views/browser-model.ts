import { Popover } from "@foldkit/ui";
import { Schema } from "effect";
import { SavedView, SavedViewsPage } from "../../../../shared/saved-views";
import { empty, request } from "../../lib/request-state";

export const RecentIds = Schema.Array(SavedView.fields.id).check(
  Schema.isMaxLength(5),
);
export const PickerMode = Schema.Union([
  Schema.TaggedStruct("Quick", {}),
  Schema.TaggedStruct("Browse", {}),
  Schema.TaggedStruct("Search", { query: Schema.String }),
]);
export const Shortcuts = Schema.Struct({
  rows: Schema.Array(SavedView),
  recents: Schema.Array(SavedView),
});
export const Model = Schema.Struct({
  savedViews: request(SavedViewsPage),
  savedViewPages: Schema.Number,
  pickerMode: PickerMode,
  searchVersion: Schema.Number,
  shortcuts: request(Shortcuts),
  shortcutVersion: Schema.Number,
  recentIds: RecentIds,
  picker: Popover.Model,
});
export type Model = typeof Model.Type;
export const init = (): Model => ({
  savedViews: empty,
  savedViewPages: 1,
  pickerMode: { _tag: "Quick" },
  searchVersion: 0,
  shortcuts: empty,
  shortcutVersion: 0,
  recentIds: [],
  picker: Popover.init({
    id: "saved-views-picker",
    contentFocus: true,
    isModal: true,
  }),
});
