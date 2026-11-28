import { Dialog } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { Filters } from "@dsiem/analytics-shared/filters";
import * as Browser from "./browser-model";
import { writes } from "./workflow";

export const Model = Schema.Struct({
  dialogs: Schema.Struct({ savedView: Dialog.Model, delete: Dialog.Model }),
  browser: Browser.Model,
  writes: writes.Model,
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
  writes: writes.init(),
  selection: Option.none(),
  notice: "",
});
