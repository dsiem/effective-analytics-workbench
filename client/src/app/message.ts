import { Notice } from "../lib/request-state";
import { Schema } from "effect";
import { Calendar } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { CurrentUser } from "@dsiem/analytics-shared/current-user";
import { DatasetMetadata } from "@dsiem/analytics-shared/dataset";
import * as AnalysisRuns from "../features/analysis-runs/messages";
import * as Filters from "../features/filters/messages";
import * as Genie from "../features/genie/messages";
import * as Gps from "../features/gps/messages";
import * as Overview from "../features/overview/messages";
import * as SavedViews from "../features/saved-views/messages";
import * as Trips from "../features/trips/messages";
import * as Layout from "./layout";
import * as Navigation from "./navigation";
import * as Theme from "./theme";
export const Message = defineMessageUnion({
  LoadPage: {},
  CompletedFocus: {},
  CompletedFocusAnalysisHeading: {},
  GotLayoutMessage: { message: Layout.Message },
  GotNavigationMessage: { message: Navigation.Message },
  GotThemeMessage: { message: Theme.Message },
  Booted: {
    sidebar: Schema.Boolean,
    mobile: Schema.Boolean,
    themePreference: Theme.ThemePreference,
  },
  LoadedMetadata: {
    data: Schema.NullOr(DatasetMetadata),
    error: Notice,
    today: Calendar.CalendarDate,
  },
  LoadedUser: { user: Schema.NullOr(CurrentUser) },
  GotFiltersMessage: { message: Filters.Message },
  GotOverviewMessage: { message: Overview.Message },
  GotTripsMessage: { message: Trips.Message },
  GotSavedViewsMessage: { message: SavedViews.Message },
  GotGenieMessage: { message: Genie.Message },
  GotGpsMessage: { message: Gps.Message },
  GotAnalysisRunsMessage: { message: AnalysisRuns.Message },
});
export type Message = typeof Message.Type;
