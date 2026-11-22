import type { GenieContext } from "../../../../shared/genie";
import type { Filters } from "../../../../shared/filters";
import { endpointName, type Model } from "./model";
export function gpsContext(model: Model, filters: Filters): GenieContext {
  const data = model.activity.data;
  const selected = model.selectedCell;
  return {
    page: "map",
    title: `GPS ${endpointName(model.endpoint)}`,
    ...(data &&
    !model.activity.loading &&
    !model.activity.error &&
    !model.mapError
      ? {
          data: JSON.stringify({
            query: { filters, endpoint: model.endpoint },
            scope: data.truncated
              ? "bounded-map-subset"
              : "complete-map-aggregation",
            selectedCellId: model.selected,
            loadedCells: data.loaded,
            totalCells: data.totalCells,
            sampledAreas: data.cells.length,
            endpoint: model.endpoint,
            matchingTrips: data.matchingTrips,
            locatedTrips: data.locatedTrips,
            shownTrips: data.shownTrips,
            truncated: data.truncated,
            resolution: 10,
            selectedArea: selected,
            topAreas: data.cells.slice(0, 5),
            geography:
              "Hexagons aggregate actual GPS endpoints at H3 resolution 10. Cell centers are not individual trip locations. Date and ZIP filters apply to pickups.",
            queriedAt: data.queriedAt,
          }),
        }
      : {}),
  };
}
