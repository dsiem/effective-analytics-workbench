import { Option } from "effect";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { TripSort } from "@dsiem/analytics-shared/trips";
import { href } from "../domain/filters";
import {
  closeAnalysisForm,
  openAnalysisRuns,
} from "../features/analysis-runs/update";
import * as FilterDates from "../features/filters/dates";
import { clearSelection } from "../features/genie/update";
import { reloadGps } from "../features/gps/update";
import { reloadOverview } from "../features/overview/update";
import {
  closeSavedViewsPicker,
  clearNotice,
} from "../features/saved-views/update";
import { reloadTrips, resetTrips } from "../features/trips/update";
import type { ApiClient } from "../lib/api-client";
import { FocusAnalysisHeading } from "./commands";
import * as Features from "./features";
import * as Layout from "./layout";
import type { Message } from "./message";
import type { Model } from "./model";
import { Navigate } from "./navigation";
import { AppRoute, pageUrls, showsExplore, withTripSort } from "./route";

type PageUpdate = Update.Return<Model, Message, ApiClient>;

export const clearGenieSelection = (model: Model): PageUpdate =>
  Features.genie.foldInit(model, clearSelection(model.genieState));

export function loadPage(model: Model): PageUpdate {
  const { route, query } = model.location;
  const filters = Option.getOrUndefined(model.location.filters);
  return AppRoute.match<PageUpdate>(route, {
    AnalysisRuns: ({ run }) =>
      Features.analysisRuns.foldInit(
        model,
        openAnalysisRuns(model.analysisRunsState, run),
      ),
    TripMap: () =>
      filters
        ? Features.gps.foldInit(
            clearGenieSelection(model).model,
            reloadGps(model.gpsState, { query, filters }),
          )
        : { model },
    Overview: () =>
      filters
        ? Features.overview.foldInit(
            clearGenieSelection(model).model,
            reloadOverview(model.overviewState, filters),
          )
        : { model },
    Trips: ({ sort }) =>
      filters
        ? Features.trips.foldInit(
            clearGenieSelection(model).model,
            reloadTrips(model.tripsState, { filters, sort }),
          )
        : { model },
    Genie: () => ({ model }),
    NotFound: () => ({ model }),
  });
}

export function changePage(model: Model, previous: AppRoute): PageUpdate {
  const { route, filters } = model.location;
  return Update.combine(model, [
    (parent) =>
      Features.layout.foldInit(parent, {
        model: Layout.closeNavigation(parent.layout, true),
      }),
    (parent) => Features.trips.foldInit(parent, resetTrips(parent.tripsState)),
    (parent) =>
      Features.analysisRuns.foldInit(
        parent,
        closeAnalysisForm(parent.analysisRunsState),
      ),
    (parent) => {
      const picker =
        showsExplore(previous) && !showsExplore(route)
          ? closeSavedViewsPicker(parent.savedViewsState)
          : { model: parent.savedViewsState };
      return Features.savedViews.foldInit(parent, {
        ...picker,
        model: clearNotice(picker.model),
      });
    },
    (parent) =>
      Features.filters.foldInit(parent, {
        model: FilterDates.reset(
          parent.filtersState,
          Option.getOrElse(filters, () => ({})),
          Option.getOrNull(AsyncData.getData(parent.metadata)),
        ),
      }),
    clearGenieSelection,
    loadPage,
    (parent) =>
      previous._tag === "AnalysisRuns" && route._tag === "AnalysisRuns"
        ? { model: parent, commands: [FocusAnalysisHeading()] }
        : { model: parent },
  ]);
}

export function sortTrips(
  model: Model,
  sort: typeof TripSort.Type,
): PageUpdate {
  const query = withTripSort(model.location.query, sort);
  const loaded = loadPage(
    modifyFields(model, {
      location: (location) =>
        modifyFields(location, {
          route: () => AppRoute.Trips({ sort }),
          query: () => query,
        }),
    }),
  );
  return {
    ...loaded,
    commands: [
      ...(loaded.commands ?? []),
      Features.navigation.mapCommand(
        Navigate({ href: href(pageUrls.Trips, query), external: false }),
      ),
    ],
  };
}
