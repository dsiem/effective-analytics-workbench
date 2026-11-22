import { Notice } from "../../lib/request-state";
import { Dialog } from "@foldkit/ui";
import { Schema } from "effect";
import { SavedView, SavedViewInput } from "../../../../shared/saved-views";
import { Filters } from "../../../../shared/filters";
import * as Browser from "./browser-model";
export const SavedViewEditor = Schema.Struct({
  draft: SavedViewInput,
  saving: Schema.Boolean,
  error: Notice,
});
export const Model = Schema.Struct({
  dialogs: Schema.Struct({ savedView: Dialog.Model, delete: Dialog.Model }),
  browser: Browser.Model,
  editor: Schema.NullOr(SavedViewEditor),
  deleting: Schema.NullOr(SavedView),
  savedViewBusy: Schema.Boolean,
  savedViewError: Notice,
  selection: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      filters: Filters,
    }),
  ),
  notice: Schema.String,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  dialogs: {
    savedView: Dialog.init({
      id: "saved-view",
      focusSelector: "#saved-view-title",
    }),
    delete: Dialog.init({ id: "delete-saved-view", focusSelector: "button" }),
  },
  browser: Browser.init(),
  editor: null,
  deleting: null,
  savedViewBusy: false,
  savedViewError: "",
  selection: null,
  notice: "",
});
