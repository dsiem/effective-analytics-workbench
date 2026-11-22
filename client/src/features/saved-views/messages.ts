import { Notice } from "../../lib/request-state";
import { Dialog, Popover } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { SavedView, SavedViewsPage } from "../../../../shared/saved-views";
import { RecentIds, Shortcuts } from "./browser-model";

const messages = {
  CloseSavedView: {},
  CloseDelete: {},
  SavedViewDialog: { message: Dialog.Message },
  DeleteDialog: { message: Dialog.Message },
  SavedViewsPicker: { message: Popover.Message },
  ClearView: {},
  NewSavedView: {},
  CreatedSavedView: { id: Schema.String },
  EditSavedView: { savedView: SavedView },
  SavedViewChanged: {
    field: Schema.Literals(["title", "body"]),
    value: Schema.String,
  },
  SaveSavedView: {},
  SavedViewSaved: {
    savedView: Schema.NullOr(SavedView),
    error: Notice,
  },
  LoadSavedViews: { more: Schema.Boolean },
  SavedViewSearchChanged: { value: Schema.String },
  BrowseSavedViews: {},
  ShowSavedViewShortcuts: {},
  LoadSavedViewShortcuts: {},
  LoadedSavedViewShortcuts: {
    version: Schema.Number,
    data: Schema.NullOr(Shortcuts),
    recentIds: RecentIds,
    error: Notice,
  },
  CompletedCancelLoadSavedViews: {
    version: Schema.Number,
    more: Schema.Boolean,
    debounce: Schema.Boolean,
  },
  LoadedSavedViews: {
    data: Schema.NullOr(SavedViewsPage),
    error: Notice,
    more: Schema.Boolean,
    pages: Schema.Number,
    version: Schema.Number,
  },
  PinSavedView: { savedView: SavedView },
  DeleteSavedView: { savedView: SavedView },
  ConfirmDelete: {},
  MutatedSavedView: { removed: Schema.Boolean, error: Notice },
  RestoreView: { savedView: SavedView },
};

export const Message = defineMessageUnion({ Idle: {}, ...messages });
export type Message = typeof Message.Type;
