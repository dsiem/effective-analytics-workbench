import { defineView } from "foldkit/submodel";
import { type Filters, sameFilters } from "../../../../shared/filters";
import { savedViewBrowser } from "./browser-view";
import type { Model } from "./model";
import { appliedView } from "./selection";
import { Message as M } from "./view-messages";

type ViewModel = Pick<
  Model,
  "browser" | "selection" | "savedViewBusy" | "savedViewError" | "deleting"
> & {
  readonly filters: Filters;
  readonly canSave: boolean;
};

export const savedViewsView = defineView<ViewModel, typeof M.Type>(
  (model, h) => {
    const { filters } = model;
    return savedViewBrowser(h, {
      ...model.browser,
      selected: appliedView(model, filters),
      customFilters: !sameFilters(filters, {}),
      canSave: model.canSave,
      mutationBusy: model.savedViewBusy,
      mutationError: model.deleting ? "" : model.savedViewError,
    });
  },
);
