import { Completion } from "../../lib/command-result";
import { Dialog, Popover } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { SavedView } from "@dsiem/analytics-shared/saved-views";
import { RecentIds, Shortcuts } from "./browser-model";
import { search, writes } from "./workflow";

const browserMessages = {
  GotSavedViewsPickerMessage: { message: Popover.Message },
  MovedSavedViewPickerFocus: { id: Schema.String },
  CompletedPersistRecentSavedViews: {},
  CompletedRememberRecentSavedView: {},
  CompletedFocusSavedViewSearch: {},
  GotFindingSearchMessage: { message: search.Message },
  SavedViewSearchChanged: { value: Schema.String },
  BrowseSavedViews: {},
  ShowSavedViewShortcuts: {},
  LoadSavedViewShortcuts: {},
  LoadedSavedViewShortcuts: {
    version: Schema.Number,
    result: Completion(Shortcuts),
    recentIds: RecentIds,
  },
};

export const BrowserMessage = defineMessageUnion(browserMessages);
export type BrowserMessage = typeof BrowserMessage.Type;

export const Message = defineMessageUnion({
  ...browserMessages,
  GotSavedViewDialogMessage: { message: Dialog.Message },
  GotDeleteDialogMessage: { message: Dialog.Message },
  GotFindingWriteMessage: { message: writes.Message },
  ClearView: {},
  NewSavedView: {},
  RestoreView: { savedView: SavedView },
});
export type Message = typeof Message.Type;

export const findingSearch = (message: typeof search.Message.Type) =>
  Message.GotFindingSearchMessage({ message });
export const findingWrite = (message: typeof writes.Message.Type) =>
  Message.GotFindingWriteMessage({ message });
