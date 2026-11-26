import type { SavedView } from "@dsiem/analytics-shared/saved-views";

export const airportView: SavedView = {
  id: "8aa0cc1a-6033-4fd0-9a61-908958570382",
  title: "Airport pickups",
  body: "Review January airport trips.",
  filters: { from: "2016-01-10", to: "2016-01-20", zip: "11430" },
  version: 1,
  pinned: true,
  created_at: "2026-11-14T10:00:00Z",
  updated_at: "2026-11-14T10:00:00Z",
};
