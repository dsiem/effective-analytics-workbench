import { defineView } from "foldkit/submodel";
import { type Filters, sameFilters } from "@dsiem/analytics-shared/filters";
import { Option } from "effect";
import { savedViewBrowser } from "./browser-view";
import type { Model } from "./model";
import { appliedView } from "./selection";
import { Message as M } from "./view-messages";

type ViewInputs = {
  readonly filters: Filters;
  readonly canSave: boolean;
};

export const savedViewsView = defineView<Model, typeof M.Type, ViewInputs>(
  (model, { filters, canSave }, h) =>
    savedViewBrowser(h, {
      ...model.browser,
      selected: appliedView(model, filters),
      customFilters: !sameFilters(filters, {}),
      canSave,
      mutationBusy: model.savedViewBusy,
      mutationError: Option.isSome(model.deleting) ? "" : model.savedViewError,
    }),
);
