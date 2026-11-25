import { Option } from "effect";
import { AsyncData, Command, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";
import { href, queryFor } from "../domain/filters";
import * as AnalysisDates from "../features/analysis-runs/dates";
import * as AnalysisRuns from "../features/analysis-runs/model";
import { updateAnalysisRuns } from "../features/analysis-runs/update";
import * as FilterDates from "../features/filters/dates";
import * as Filters from "../features/filters/model";
import { updateFilters } from "../features/filters/update";
import * as GenieCommands from "../features/genie/commands";
import * as Genie from "../features/genie/model";
import { presentGenie, updateGenie } from "../features/genie/update";
import * as Gps from "../features/gps/model";
import { updateGps } from "../features/gps/update";
import * as Overview from "../features/overview/model";
import { updateOverview } from "../features/overview/update";
import * as SavedViews from "../features/saved-views/model";
import { updateSavedViews } from "../features/saved-views/update";
import * as Trips from "../features/trips/model";
import { closeSortMenu, updateTrips } from "../features/trips/update";
import type { ApiClient } from "../lib/api-client";
import { pageContext } from "./analysis-context";
import * as AppCommands from "./commands";
import * as Features from "./features";
import { Message as M, type Message } from "./message";
import type { Model } from "./model";
import * as Layout from "./layout";
import * as Navigation from "./navigation";
import { changePage, clearGenieSelection, loadPage, sortTrips } from "./page";
import { parseLocation, routePath, showsExplore, withTripSort } from "./route";
import * as Theme from "./theme";

type AppUpdate = Update.Return<Model, Message, ApiClient>;

export function init(url: Url): AppUpdate {
  const location = parseLocation(
    url.pathname,
    Option.getOrElse(url.search, () => "").replace(/^\?/, ""),
  );
  const model: Model = {
    location,
    layout: Layout.init(),
    theme: Theme.init(),
    metadata: AsyncData.Loading(),
    user: Option.none(),
    filtersState: Filters.init(Option.getOrElse(location.filters, () => ({}))),
    overviewState: Overview.init(),
    tripsState: Trips.init(),
    savedViewsState: SavedViews.init(),
    genieState: Genie.init(),
    gpsState: Gps.init(),
    analysisRunsState: AnalysisRuns.init(),
  };
  const loaded = loadPage(model);
  return {
    ...loaded,
    commands: [
      ...(loaded.commands ?? []),
      AppCommands.RestoreWorkspace(),
      Command.mapMessage(
        GenieCommands.RestoreConversation(),
        Features.genie.toParentMessage,
      ),
      AppCommands.LoadMetadata(),
      AppCommands.LoadUser(),
    ],
  };
}

function updateApplication(model: Model, message: Message): AppUpdate {
  const { route, query } = model.location;
  const filters = Option.getOrNull(model.location.filters);
  return M.match<AppUpdate>(message, {
    CompletedFocus: () => ({ model }),
    CompletedFocusAnalysisHeading: () => ({ model }),
    GotLayoutMessage: ({ message }) =>
      Update.foldChild({ ...Features.layout, update: Layout.update })(
        model,
        message,
      ),
    GotThemeMessage: ({ message }) =>
      Update.foldChild({ ...Features.theme, update: Theme.update })(
        model,
        message,
      ),
    GotNavigationMessage: ({ message }) =>
      Update.foldChild({
        ...Features.navigation,
        update: Navigation.update,
        foldOutMessage:
          (out) =>
          (parent): AppUpdate =>
            out === "LocationChanged"
              ? changePage(parent, route)
              : Features.layout.foldInit<never>(parent, {
                  model: Layout.closeNavigation(parent.layout),
                }),
      })(model, message),
    Booted: (restored) =>
      Features.theme.foldInit(
        Features.layout.foldInit(model, {
          model: Layout.restore(model.layout, restored),
        }).model,
        Theme.restore(model.theme, restored.themePreference),
      ),
    LoadedMetadata: ({ result, today }) => {
      const metadata = AsyncData.getOrElse(result, () => null);
      return Update.combine(model, [
        (parent) => ({
          model: modifyFields(parent, {
            metadata: () => result,
          }),
        }),
        (parent) =>
          Features.analysisRuns.foldInit(parent, {
            model: AnalysisDates.withMetadata(
              parent.analysisRunsState,
              metadata,
              today,
            ),
          }),
        (parent) =>
          Features.filters.foldInit(parent, {
            model: FilterDates.withMetadata(
              parent.filtersState,
              metadata,
              today,
            ),
          }),
      ]);
    },
    LoadedUser: ({ result }) => {
      return {
        model: modifyFields(model, {
          user: () =>
            Option.flatMap(AsyncData.getData(result), Option.fromNullishOr),
        }),
      };
    },
    LoadPage: () => {
      return loadPage(model);
    },
    GotAnalysisRunsMessage: (message) => {
      return Update.foldChild({
        ...Features.analysisRuns,
        update: (
          child: AnalysisRuns.Model,
          childMessage: typeof message.message,
        ) =>
          updateAnalysisRuns(
            child,
            childMessage,
            route._tag === "AnalysisRuns" ? query : null,
          ),
      })(model, message.message);
    },
    GotFiltersMessage: (message) => {
      return Update.foldChild({
        ...Features.filters,
        update: (child: Filters.Model, childMessage: typeof message.message) =>
          updateFilters(child, childMessage, {
            filters,
            metadata: Option.getOrNull(AsyncData.getData(model.metadata)),
          }),
        foldOutMessage: (out) => (parent) => ({
          model: parent,
          commands: [
            Features.navigation.mapCommand(
              Navigation.Navigate({
                href: href(
                  routePath(route),
                  route._tag === "Trips"
                    ? withTripSort(out.query, route.sort)
                    : out.query,
                ),
                external: false,
              }),
            ),
          ],
        }),
      })(model, message.message);
    },
    GotOverviewMessage: (message) => {
      if (route._tag !== "Overview" || !filters) return { model };
      return Update.foldChild({
        ...Features.overview,
        update: updateOverview,
        foldOutMessage: () => clearGenieSelection,
      })(model, message.message);
    },
    GotTripsMessage: (message) => {
      return Update.foldChild({
        ...Features.trips,
        update: updateTrips,
        foldOutMessage:
          ({ sort }) =>
          (parent) =>
            route._tag === "Trips" && route.sort !== sort
              ? sortTrips(parent, sort)
              : { model: parent },
      })(model, message.message);
    },
    GotSavedViewsMessage: (message) => {
      return Update.foldChild({
        ...Features.savedViews,
        update: (
          child: SavedViews.Model,
          childMessage: typeof message.message,
        ) => updateSavedViews(child, childMessage, { filters: filters ?? {} }),
        foldOutMessage:
          ({ filters: restoredFilters }) =>
          (parent) => ({
            model: Features.filters.foldInit(parent, {
              model: FilterDates.reset(
                parent.filtersState,
                restoredFilters,
                Option.getOrNull(AsyncData.getData(parent.metadata)),
              ),
            }).model,
            commands: [
              Features.navigation.mapCommand(
                Navigation.Navigate({
                  href: href(routePath(route), queryFor(restoredFilters)),
                  external: false,
                }),
              ),
            ],
          }),
      })(model, message.message);
    },
    GotGenieMessage: (message) => {
      return Update.foldChild({
        ...Features.genie,
        update: (child: Genie.Model, childMessage: typeof message.message) =>
          updateGenie(child, childMessage, {
            filters,
            context: pageContext(model),
          }),
        foldOutMessage: (out) => (parent) => ({
          model:
            out._tag === "Opened"
              ? Features.layout.foldInit(parent, {
                  model: Layout.closeNavigation(parent.layout),
                }).model
              : parent,
          commands: [AppCommands.Focus({ selector: "#genie-composer" })],
        }),
      })(model, message.message);
    },
    GotGpsMessage: (message) => {
      if (route._tag !== "TripMap" || !filters) return { model };
      return Update.foldChild({
        ...Features.gps,
        update: (child: Gps.Model, childMessage: typeof message.message) =>
          updateGps(child, childMessage, { query, filters }),
        foldOutMessage: () => clearGenieSelection,
      })(model, message.message);
    },
  });
}

export function update(model: Model, message: Message): AppUpdate {
  return Update.combine(model, [
    (parent) => updateApplication(parent, message),
    (parent) =>
      parent.tripsState.sortMenu.isOpen &&
      (!parent.layout.mobile || parent.location.route._tag !== "Trips")
        ? Features.trips.foldInit(parent, closeSortMenu(parent.tripsState))
        : { model: parent },
    // Release the child menu's resources when the mobile drawer is removed.
    (parent) =>
      parent.layout.mobile && !parent.layout.mobileNavigation
        ? Features.theme.foldInit(parent, Theme.closeMenu(parent.theme))
        : { model: parent },
    (parent) =>
      Features.layout.foldInit(
        parent,
        Layout.syncNavigationDialog(parent.layout),
      ),
    (parent) =>
      Features.genie.foldInit(
        parent,
        presentGenie(
          parent.genieState,
          parent.layout.mobile && showsExplore(parent.location.route),
        ),
      ),
  ]);
}
