import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { GenieContext } from "@dsiem/analytics-shared/genie";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { endpointName, type Model } from "./model";
export function gpsContext(model: Model, filters: Filters): GenieContext {
  const { activity, selectedCell } = model;
  return {
    page: "map",
    title: `GPS ${endpointName(model.endpoint)}`,
    ...(AsyncData.isSuccess(activity) && !model.mapError
      ? {
          data: JSON.stringify({
            query: { filters, endpoint: model.endpoint },
            scope: activity.data.truncated
              ? "bounded-map-subset"
              : "complete-map-aggregation",
            selectedCellId: Option.getOrNull(model.selected),
            loadedCells: activity.data.loaded,
            totalCells: activity.data.totalCells,
            sampledAreas: activity.data.cells.length,
            endpoint: model.endpoint,
            matchingTrips: activity.data.matchingTrips,
            locatedTrips: activity.data.locatedTrips,
            shownTrips: activity.data.shownTrips,
            truncated: activity.data.truncated,
            resolution: 10,
            selectedArea: Option.getOrNull(selectedCell),
            topAreas: activity.data.cells.slice(0, 5),
            geography:
              "Hexagons aggregate actual GPS endpoints at H3 resolution 10. Cell centers are not individual trip locations. Date and ZIP filters apply to pickups.",
            queriedAt: activity.data.queriedAt,
          }),
        }
      : {}),
  };
}
