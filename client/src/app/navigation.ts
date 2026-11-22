import type { Update } from "foldkit";
import type { TripSort } from "../../../shared/trips";
import { href, withSort } from "../domain/filters";
import { openAnalysisRuns } from "../features/analysis-runs/update";
import { reloadGps } from "../features/gps/update";
import { reloadOverview } from "../features/overview/update";
import { reloadTrips } from "../features/trips/update";
import type { ApiClient } from "../lib/api-client";
import { Navigate } from "./commands";
import * as Features from "./features";
import type { Message } from "./message";
import type { Model } from "./model";
import { AppRoute, paths } from "./route";

export function loadPage(
  model: Model,
): Update.Return<Model, Message, ApiClient> {
  const { route, query, filters } = model.location;
  if (route._tag === "AnalysisRuns") {
    return Features.analysisRuns.foldInit(
      model,
      openAnalysisRuns(model.analysisRunsState, route.run),
    );
  }
  if (!filters) return { model };
  const page = {
    ...model,
    genieState: { ...model.genieState, genieSelection: null },
  };
  switch (route._tag) {
    case "TripMap":
      return Features.gps.foldInit(
        page,
        reloadGps(model.gpsState, { query, filters }),
      );
    case "Overview":
      return Features.overview.foldInit(
        page,
        reloadOverview(model.overviewState, filters),
      );
    case "Trips":
      return Features.trips.foldInit(
        page,
        reloadTrips(model.tripsState, { filters, sort: route.sort }),
      );
    case "Genie":
    case "NotFound":
      return { model };
  }
}

export function sortTrips(
  model: Model,
  sort: typeof TripSort.Type,
): Update.Return<Model, Message, ApiClient> {
  const query = withSort(model.location.query, sort, "newest");
  const loaded = loadPage({
    ...model,
    location: { ...model.location, route: AppRoute.Trips({ sort }), query },
  });
  return {
    ...loaded,
    commands: [
      ...(loaded.commands ?? []),
      Navigate({ href: href(paths.Trips, query), external: false }),
    ],
  };
}
