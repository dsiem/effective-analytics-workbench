import { Option } from "effect";
import { AsyncData } from "foldkit";
import { type Filters, sameFilters } from "@dsiem/analytics-shared/filters";
import type { Model } from "./model";

export function appliedView(
  model: Pick<Model, "selection" | "browser">,
  filters: Filters,
) {
  const selection = Option.getOrUndefined(model.selection);
  if (selection && sameFilters(selection.filters, filters)) return selection;
  const results = Option.getOrUndefined(
    AsyncData.getData(model.browser.search.data),
  );
  const shortcuts = Option.getOrUndefined(
    AsyncData.getData(model.browser.shortcuts),
  );
  return (
    [
      ...(results?.rows ?? []),
      ...(shortcuts?.rows ?? []),
      ...(shortcuts?.recents ?? []),
    ].find((savedView) => sameFilters(savedView.filters, filters)) ?? null
  );
}
