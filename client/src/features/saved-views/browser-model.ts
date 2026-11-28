import { Popover } from "@foldkit/ui";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { SavedView } from "@dsiem/analytics-shared/saved-views";
import { Notice } from "../../lib/request-state";
import { search } from "./workflow";

export const RecentIds = Schema.Array(SavedView.fields.id).check(
  Schema.isMaxLength(5),
);
export const Shortcuts = Schema.Struct({
  rows: Schema.Array(SavedView),
  recents: Schema.Array(SavedView),
});
export const Model = Schema.Struct({
  search: search.Model,
  pickerMode: Schema.Literals(["Quick", "Browse", "Search"]),
  shortcuts: AsyncData.Schema(Shortcuts, Notice).schema,
  shortcutVersion: Schema.Number,
  recentIds: RecentIds,
  picker: Popover.Model,
});
export type Model = typeof Model.Type;
export const init = (): Model => ({
  search: search.init(),
  pickerMode: "Quick",
  shortcuts: AsyncData.Idle(),
  shortcutVersion: 0,
  recentIds: [],
  picker: Popover.init({
    id: "saved-views-picker",
    contentFocus: true,
    isModal: true,
  }),
});
