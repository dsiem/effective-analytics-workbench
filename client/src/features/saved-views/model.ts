import { Notice } from "../../lib/request-state";
import { Dialog } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { findingEditor } from "@dsiem/workbench-ui/findings";
import { SavedView } from "@dsiem/analytics-shared/saved-views";
import { Filters } from "@dsiem/analytics-shared/filters";
import * as Browser from "./browser-model";
export const editorWorkflow = findingEditor(Filters, Notice, "");
export const SavedViewEditor = editorWorkflow.Model;
export const Model = Schema.Struct({
  dialogs: Schema.Struct({ savedView: Dialog.Model, delete: Dialog.Model }),
  browser: Browser.Model,
  editor: Schema.Option(SavedViewEditor),
  deleting: Schema.Option(SavedView),
  savedViewBusy: Schema.Boolean,
  savedViewError: Notice,
  selection: Schema.Option(
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
  editor: Option.none(),
  deleting: Option.none(),
  savedViewBusy: false,
  savedViewError: "",
  selection: Option.none(),
  notice: "",
});
