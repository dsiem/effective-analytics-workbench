import { defineView } from "foldkit/submodel";
import { type Filters, sameFilters } from "@dsiem/analytics-shared/filters";
import { savedViewBrowser } from "./browser-view";
import type { Model } from "./model";
import { appliedView } from "./selection";
import { Message as M } from "./view-messages";

type ViewInputs = {
  readonly filters: Filters;
  readonly canSave: boolean;
};

export const savedViewsView = defineView<Model, typeof M.Type, ViewInputs>(
  (model, { filters, canSave }, h) => {
    const panel = model.writes.panel;
    return savedViewBrowser(h, {
      ...model.browser,
      selected: appliedView(model, filters),
      customFilters: !sameFilters(filters, {}),
      canSave: canSave && panel._tag === "Browse",
      canMutate: panel._tag === "Browse",
      mutationBusy:
        panel._tag === "Pinning" || (panel._tag === "Delete" && panel.busy),
      mutationError: panel._tag === "Browse" ? (panel.error ?? "") : "",
    });
  },
);
