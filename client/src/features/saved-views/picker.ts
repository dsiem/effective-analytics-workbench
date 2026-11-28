import { Option } from "effect";
import { AsyncData } from "foldkit";
export { mergeFindingPages as mergeSavedViews } from "@dsiem/workbench-ui/findings";
import type { Model } from "./browser-model";

export const searchId = "saved-view-search";
export const resultId = (id: string) => `saved-view-result-${id}`;
export const searchText = (model: Model) =>
  model.pickerMode._tag === "Search" ? model.pickerMode.query : "";

export function shortcutGroups(model: Model) {
  if (!AsyncData.isSuccess(model.shortcuts)) return [];
  const { data } = model.shortcuts;
  const pinned = data.rows.filter((row) => row.pinned).slice(0, 5);
  const used = new Set(pinned.map((row) => row.id));
  const recent = model.recentIds.flatMap((id) => {
    const row = data.recents.find((entry) => entry.id === id);
    if (!row || used.has(id)) return [];
    used.add(id);
    return [row];
  });
  const fallback = recent.length
    ? []
    : data.rows.filter((row) => !used.has(row.id)).slice(0, 5);
  return [
    { title: "Pinned", rows: pinned },
    { title: "Recently used", rows: recent },
    {
      title: fallback.some((row) => row.pinned)
        ? "More saved views"
        : "Recently updated",
      rows: fallback,
    },
  ].filter((group) => group.rows.length);
}

export const visibleSavedViews = (model: Model) =>
  model.pickerMode._tag === "Quick"
    ? shortcutGroups(model).flatMap((group) => group.rows)
    : (Option.getOrUndefined(AsyncData.getData(model.savedViews))?.rows ?? []);

export const rememberRecent = (ids: readonly string[], id: string) =>
  [id, ...ids.filter((entry) => entry !== id)].slice(0, 5);
