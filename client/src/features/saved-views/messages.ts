import { Completion } from "../../lib/command-result";
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
    result: Completion(Shortcuts),
    recentIds: RecentIds,
  },
  CompletedCancelLoadSavedViews: {
    version: Schema.Number,
    more: Schema.Boolean,
    debounce: Schema.Boolean,
  },
  LoadedSavedViews: {
    result: Completion(SavedViewsPage),
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
    result: Completion(SavedView),
  },
  PinSavedView: { savedView: SavedView },
  DeleteSavedView: { savedView: SavedView },
  ConfirmDelete: {},
  MutatedSavedView: {
    result: Completion(Schema.Struct({ removed: Schema.Boolean })),
  },
  RestoreView: { savedView: SavedView },
});
export type Message = typeof Message.Type;
