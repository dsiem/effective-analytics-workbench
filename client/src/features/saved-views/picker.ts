import type { SavedView } from "@dsiem/analytics-shared/saved-views";
import type { Model } from "./browser-model";

export const searchId = "saved-view-search";
export const resultId = (id: string) => `saved-view-result-${id}`;
export const searchText = (model: Model) =>
  model.pickerMode._tag === "Search" ? model.pickerMode.query : "";

export function shortcutGroups(model: Model) {
  const data = model.shortcuts.data;
  if (!data || model.shortcuts.loading || model.shortcuts.error) return [];
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
    : (model.savedViews.data?.rows ?? []);

export const rememberRecent = (ids: readonly string[], id: string) =>
  [id, ...ids.filter((entry) => entry !== id)].slice(0, 5);

export const mergeSavedViews = (
  previous: readonly SavedView[],
  next: readonly SavedView[],
) => [...new Map([...previous, ...next].map((row) => [row.id, row])).values()];
