import { Dialog, Menu, Tooltip } from "@foldkit/ui";
import { Option } from "effect";
import { Command, Update } from "foldkit";
import type { Url } from "foldkit/url";
import { href, queryFor } from "../domain/filters";
import * as AnalysisDates from "../features/analysis-runs/dates";
import * as AnalysisRuns from "../features/analysis-runs/model";
import {
  closeAnalysisForm,
  updateAnalysisRuns,
} from "../features/analysis-runs/update";
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
import {
  closeSavedViewsPicker,
  updateSavedViews,
} from "../features/saved-views/update";
import { Message as TripMessage } from "../features/trips/messages";
import * as Trips from "../features/trips/model";
import { updateTrips } from "../features/trips/update";
import type { ApiClient } from "../lib/api-client";
import { syncDialog } from "../lib/dialog";
import { pending } from "../lib/request-state";
import { pageContext } from "./analysis-context";
import * as AppCommands from "./commands";
import * as Features from "./features";
import { Message as M, type Message } from "./message";
import type { Model } from "./model";
import { loadPage, sortTrips } from "./navigation";
import { parseLocation, routePath, showsExplore, withTripSort } from "./route";
import { ThemeMenu } from "./theme";
import { initTooltip } from "./ui-state";

export function init(url: Url): Update.Return<Model, Message, ApiClient> {
  const location = parseLocation(
    url.pathname,
    Option.getOrElse(url.search, () => "").replace(/^\?/, ""),
  );
  const model: Model = {
    location,
    sidebar: true,
    themePreference: "System",
    themeMenu: Menu.init({ id: "theme" }),
    mobile: false,
    mobileNavigation: false,
    tooltips: {},
    navigationDialog: Dialog.init({
      id: "mobile-navigation",
      focusSelector: "a",
    }),
    metadata: pending,
    user: null,
    filtersState: Filters.init(location.filters ?? {}),
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
      AppCommands.Boot(),
      Command.mapMessage(
        GenieCommands.RestoreConversation(),
        Features.genie.toParentMessage,
      ),
      AppCommands.LoadMetadata(),
      AppCommands.LoadUser(),
    ],
  };
}

function invalidateGenieSelection(model: Model): Model {
  return model.genieState.genieSelection === null
    ? model
    : { ...model, genieState: { ...model.genieState, genieSelection: null } };
}

function updateApplication(
  model: Model,
  message: Message,
): Update.Return<Model, Message, ApiClient> {
  const { route, query, filters } = model.location;
  switch (message._tag) {
    case "Idle":
      return { model };
    case "Navigate":
      return { model, commands: [AppCommands.Navigate(message)] };
    case "Navigated": {
      if (routePath(route) === message.path && query === message.query)
        return {
          model: model.mobileNavigation
            ? { ...model, mobileNavigation: false }
            : model,
        };
      const location = parseLocation(message.path, message.query);
      const reset = updateTrips(model.tripsState, TripMessage.ResetTrips());
      const analysis = closeAnalysisForm(model.analysisRunsState);
      const savedViews =
        showsExplore(route) && !showsExplore(location.route)
          ? closeSavedViewsPicker(model.savedViewsState)
          : { model: model.savedViewsState };
      const loaded = loadPage({
        ...model,
        location,
        mobileNavigation: false,
        tooltips: {},
        filtersState: FilterDates.reset(
          model.filtersState,
          location.filters ?? {},
          model.metadata.data,
        ),
        savedViewsState: { ...savedViews.model, notice: "" },
        analysisRunsState: analysis.model,
        tripsState: reset.model,
        genieState: { ...model.genieState, genieSelection: null },
      });
      return {
        ...loaded,
        commands: [
          ...(reset.commands ?? []).map((command) =>
            Command.mapMessage(command, Features.trips.toParentMessage),
          ),
          ...(analysis.commands ?? []).map((command) =>
            Command.mapMessage(command, Features.analysisRuns.toParentMessage),
          ),
          ...(savedViews.commands ?? []).map((command) =>
            Command.mapMessage(command, Features.savedViews.toParentMessage),
          ),
          ...(loaded.commands ?? []),
          ...(route._tag === "AnalysisRuns" &&
          location.route._tag === "AnalysisRuns"
            ? [AppCommands.FocusAnalysisHeading()]
            : []),
        ],
      };
    }
    case "Booted":
      return {
        model: {
          ...model,
          sidebar: message.sidebar,
          mobile: message.mobile,
          themePreference: message.themePreference,
        },
        commands: [
          AppCommands.SetTheme({
            preference: message.themePreference,
            persist: false,
          }),
        ],
      };
    case "ThemeMenu": {
      const changed = ThemeMenu.update(model.themeMenu, message.message);
      const preference = changed.outMessage?.value;
      return {
        model: {
          ...model,
          themeMenu: changed.model,
          themePreference: preference ?? model.themePreference,
        },
        commands: [
          ...(changed.commands ?? []).map((command) =>
            Command.mapMessage(command, (message) => M.ThemeMenu({ message })),
          ),
          ...(preference
            ? [AppCommands.SetTheme({ preference, persist: true })]
            : []),
        ],
      };
    }
    case "SystemThemeChanged":
      return {
        model,
        commands:
          model.themePreference === "System"
            ? [AppCommands.SetTheme({ preference: "System", persist: false })]
            : [],
      };
    case "Resized":
      return {
        model: {
          ...model,
          mobile: message.mobile,
          mobileNavigation: false,
          tooltips: {},
        },
      };
    case "ToggleSidebar":
      return model.mobile
        ? { model: { ...model, mobileNavigation: !model.mobileNavigation } }
        : {
            model: { ...model, sidebar: !model.sidebar, tooltips: {} },
            commands: [AppCommands.PersistSidebar({ open: !model.sidebar })],
          };
    case "CloseNavigation":
      return { model: { ...model, mobileNavigation: false } };
    case "Tooltip":
      return Update.foldChild({
        update: Tooltip.update,
        read: (model: Model) =>
          Option.some(model.tooltips[message.id] ?? initTooltip(message.id)),
        write: (model, child) => ({
          ...model,
          tooltips: { ...model.tooltips, [message.id]: child },
        }),
        toParentMessage: (child) =>
          M.Tooltip({ id: message.id, message: child }),
        foldOutMessage: () => (model) => ({ model }),
      })(model, message.message);
    case "NavigationDialog": {
      const changed = Dialog.update(model.navigationDialog, message.message);
      return {
        model: {
          ...model,
          navigationDialog: changed.model,
          mobileNavigation:
            changed.outMessage?._tag === "Closed"
              ? false
              : model.mobileNavigation,
        },
        commands: (changed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) =>
            M.NavigationDialog({ message }),
          ),
        ),
      };
    }
    case "LoadedMetadata":
      return {
        model: {
          ...model,
          analysisRunsState: AnalysisDates.withMetadata(
            model.analysisRunsState,
            message.data,
            message.today,
          ),
          filtersState: FilterDates.withMetadata(
            model.filtersState,
            message.data,
            message.today,
          ),
          metadata: {
            data: message.data,
            error: message.error,
            loading: false,
          },
        },
      };
    case "LoadedUser":
      return { model: { ...model, user: message.user } };
    case "LoadPage":
      return loadPage(model);
    case "AnalysisRuns":
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
    case "Filters":
      return Update.foldChild({
        ...Features.filters,
        update: (child: Filters.Model, childMessage: typeof message.message) =>
          updateFilters(child, childMessage, {
            filters,
            metadata: model.metadata.data,
          }),
        foldOutMessage: (out) => (parent) => ({
          model: parent,
          commands: [
            AppCommands.Navigate({
              href: href(
                routePath(route),
                route._tag === "Trips"
                  ? withTripSort(out.query, route.sort)
                  : out.query,
              ),
              external: false,
            }),
          ],
        }),
      })(model, message.message);
    case "Overview":
      if (route._tag !== "Overview" || !filters) return { model };
      return Update.foldChild({
        ...Features.overview,
        update: updateOverview,
        foldOutMessage: () => (parent) => ({
          model: invalidateGenieSelection(parent),
        }),
      })(model, message.message);
    case "Trips":
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
    case "SavedViews":
      return Update.foldChild({
        ...Features.savedViews,
        update: (
          child: SavedViews.Model,
          childMessage: typeof message.message,
        ) => updateSavedViews(child, childMessage, { filters: filters ?? {} }),
        foldOutMessage:
          ({ filters: restoredFilters }) =>
          (parent) => ({
            model: {
              ...parent,
              filtersState: FilterDates.reset(
                parent.filtersState,
                restoredFilters,
                parent.metadata.data,
              ),
            },
            commands: [
              AppCommands.Navigate({
                href: href(routePath(route), queryFor(restoredFilters)),
                external: false,
              }),
            ],
          }),
      })(model, message.message);
    case "Genie":
      return Update.foldChild({
        ...Features.genie,
        update: (child: Genie.Model, childMessage: typeof message.message) =>
          updateGenie(child, childMessage, {
            filters,
            context: pageContext(model),
          }),
        foldOutMessage: (out) => (parent) => ({
          model:
            out._tag === "Opened" && parent.mobileNavigation
              ? { ...parent, mobileNavigation: false }
              : parent,
          commands: [AppCommands.Focus({ selector: "#genie-composer" })],
        }),
      })(model, message.message);
    case "Gps":
      if (route._tag !== "TripMap" || !filters) return { model };
      return Update.foldChild({
        ...Features.gps,
        update: (child: Gps.Model, childMessage: typeof message.message) =>
          updateGps(child, childMessage, { query, filters }),
        foldOutMessage: () => (parent) => ({
          model: invalidateGenieSelection(parent),
        }),
      })(model, message.message);
  }
}

export function update(
  model: Model,
  message: Message,
): Update.Return<Model, Message, ApiClient> {
  const result = updateApplication(model, message);
  let next = result.model;
  const commands = [...(result.commands ?? [])];
  if (
    next.tripsState.sortMenu.isOpen &&
    (!next.mobile || next.location.route._tag !== "Trips")
  ) {
    const closed = updateTrips(
      next.tripsState,
      TripMessage.SortMenu({ message: Menu.Message.Closed() }),
    );
    next = { ...next, tripsState: closed.model };
    commands.push(
      ...(closed.commands ?? []).map((command) =>
        Command.mapMessage(command, Features.trips.toParentMessage),
      ),
    );
  }
  // Release the child menu's resources when the mobile drawer is removed.
  if (next.mobile && !next.mobileNavigation && next.themeMenu.isOpen) {
    const closed = ThemeMenu.close(next.themeMenu);
    next = { ...next, themeMenu: closed.model };
    commands.push(
      ...(closed.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) => M.ThemeMenu({ message })),
      ),
    );
  }
  const navigation = syncDialog(
    next.navigationDialog,
    next.mobile && next.mobileNavigation,
  );
  const genie = presentGenie(
    next.genieState,
    next.mobile && showsExplore(next.location.route),
  );
  return {
    model:
      navigation.model === next.navigationDialog &&
      genie.model === next.genieState
        ? next
        : {
            ...next,
            navigationDialog: navigation.model,
            genieState: genie.model,
          },
    commands: [
      ...commands,
      ...(navigation.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) =>
          M.NavigationDialog({ message }),
        ),
      ),
      ...(genie.commands ?? []).map((command) =>
        Command.mapMessage(command, Features.genie.toParentMessage),
      ),
    ],
  };
}
