import { Option, Schema } from "effect";
import { defineRouteUnion } from "foldkit/route";
import { Filters } from "../../../shared/filters";
import { TripSort } from "../../../shared/trips";
import { filtersFromQuery } from "../domain/filters";
import {
  analysisPath,
  AnalysisRunLink,
  parseRunLink,
} from "../features/analysis-runs/model";

export const paths = {
  Overview: "/",
  Trips: "/trips",
  TripMap: "/trip-map",
  AnalysisRuns: analysisPath,
  Genie: "/genie",
} as const;

export const AppRoute = defineRouteUnion({
  Overview: {},
  Trips: { sort: TripSort },
  TripMap: {},
  AnalysisRuns: { run: AnalysisRunLink },
  Genie: {},
  NotFound: { path: Schema.String },
});
export type AppRoute = typeof AppRoute.Type;

export const Location = Schema.Struct({
  route: AppRoute,
  query: Schema.String,
  filters: Schema.NullOr(Filters),
});
export type Location = typeof Location.Type;

export const routePath = (route: AppRoute) =>
  route._tag === "NotFound" ? route.path : paths[route._tag];

export const showsExplore = (route: AppRoute) =>
  route._tag !== "Genie" && route._tag !== "AnalysisRuns";

function parseRoute(path: string, params: URLSearchParams): AppRoute {
  switch (path) {
    case paths.Overview:
      return AppRoute.Overview();
    case paths.Trips:
      return AppRoute.Trips({
        sort:
          Option.getOrUndefined(
            Schema.decodeUnknownOption(TripSort)(params.get("sort")),
          ) ?? "newest",
      });
    case paths.TripMap:
      return AppRoute.TripMap();
    case paths.AnalysisRuns:
      return AppRoute.AnalysisRuns({ run: parseRunLink(params.get("run")) });
    case paths.Genie:
      return AppRoute.Genie();
    default:
      return AppRoute.NotFound({ path });
  }
}

export function parseLocation(path: string, query: string): Location {
  const params = new URLSearchParams(query);
  return {
    route: parseRoute(path, params),
    query,
    filters: filtersFromQuery(params),
  };
}
