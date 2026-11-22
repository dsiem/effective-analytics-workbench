import { Notice } from "../lib/request-state";
import { Dialog, Menu, Tooltip } from "@foldkit/ui";
import { Schema } from "effect";
import { Calendar } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { CurrentUser } from "../../../shared/current-user";
import { DatasetMetadata } from "../../../shared/dataset";
import * as AnalysisRuns from "../features/analysis-runs/messages";
import * as Filters from "../features/filters/messages";
import * as Genie from "../features/genie/messages";
import * as Gps from "../features/gps/messages";
import * as Overview from "../features/overview/messages";
import * as SavedViews from "../features/saved-views/messages";
import * as Trips from "../features/trips/messages";
import { ThemePreference } from "./theme";
export const Message = defineMessageUnion({
  Idle: {},
  LoadPage: {},
  CloseNavigation: {},
  NavigationDialog: { message: Dialog.Message },
  Navigated: { path: Schema.String, query: Schema.String },
  Navigate: { href: Schema.String, external: Schema.Boolean },
  Booted: {
    sidebar: Schema.Boolean,
    mobile: Schema.Boolean,
    themePreference: ThemePreference,
  },
  Resized: { mobile: Schema.Boolean },
  ToggleSidebar: {},
  ThemeMenu: { message: Menu.Message },
  SystemThemeChanged: {},
  Tooltip: { id: Schema.String, message: Tooltip.Message },
  LoadedMetadata: {
    data: Schema.NullOr(DatasetMetadata),
    error: Notice,
    today: Calendar.CalendarDate,
  },
  LoadedUser: { user: Schema.NullOr(CurrentUser) },
  Filters: { message: Filters.Message },
  Overview: { message: Overview.Message },
  Trips: { message: Trips.Message },
  SavedViews: { message: SavedViews.Message },
  Genie: { message: Genie.Message },
  Gps: { message: Gps.Message },
  AnalysisRuns: { message: AnalysisRuns.Message },
});
export type Message = typeof Message.Type;
