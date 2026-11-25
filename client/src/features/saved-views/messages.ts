import { Notice } from "../../lib/request-state";
import { Dialog, Popover } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { SavedView, SavedViewsPage } from "@dsiem/analytics-shared/saved-views";
import { RecentIds, Shortcuts } from "./browser-model";

const browserMessages = {
  GotSavedViewsPickerMessage: { message: Popover.Message },
  MovedSavedViewPickerFocus: { id: Schema.String },
  CompletedPersistRecentSavedViews: {},
  CompletedRememberRecentSavedView: {},
  CompletedFocusSavedViewSearch: {},
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
};

export const BrowserMessage = defineMessageUnion(browserMessages);
export type BrowserMessage = typeof BrowserMessage.Type;

export const Message = defineMessageUnion({
  ...browserMessages,
  CloseSavedView: {},
  CloseDelete: {},
  GotSavedViewDialogMessage: { message: Dialog.Message },
  GotDeleteDialogMessage: { message: Dialog.Message },
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
  PinSavedView: { savedView: SavedView },
  DeleteSavedView: { savedView: SavedView },
  ConfirmDelete: {},
  MutatedSavedView: { removed: Schema.Boolean, error: Notice },
  RestoreView: { savedView: SavedView },
});
export type Message = typeof Message.Type;
