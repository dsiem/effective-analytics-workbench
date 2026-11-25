import { type Filters, sameFilters } from "@dsiem/analytics-shared/filters";
import type { Model } from "./model";

export function appliedView(
  model: Pick<Model, "selection" | "browser">,
  filters: Filters,
) {
  const selection = model.selection;
  if (selection && sameFilters(selection.filters, filters)) return selection;
  return (
    [
      ...(model.browser.savedViews.data?.rows ?? []),
      ...(model.browser.shortcuts.data?.rows ?? []),
      ...(model.browser.shortcuts.data?.recents ?? []),
    ].find((savedView) => sameFilters(savedView.filters, filters)) ?? null
  );
}
