import { Dialog, Menu, Tooltip } from "@foldkit/ui";
import { Schema } from "effect";
import { pagePaths } from "@dsiem/analytics-shared/page-paths";
import { CurrentUser } from "@dsiem/analytics-shared/current-user";
import { DatasetMetadata } from "@dsiem/analytics-shared/dataset";
import * as AnalysisRuns from "../features/analysis-runs/model";
import * as Filters from "../features/filters/model";
import * as Genie from "../features/genie/model";
import * as Gps from "../features/gps/model";
import * as Overview from "../features/overview/model";
import * as SavedViews from "../features/saved-views/model";
import * as Trips from "../features/trips/model";
import { request } from "../lib/request-state";
import { Location } from "./route";
import { ThemePreference } from "./theme";
export const Model = Schema.Struct({
  location: Location,
  sidebar: Schema.Boolean,
  themePreference: ThemePreference,
  themeMenu: Menu.Model,
  mobile: Schema.Boolean,
  mobileNavigation: Schema.Boolean,
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
  navigationDialog: Dialog.Model,
  metadata: request(DatasetMetadata),
  user: Schema.NullOr(CurrentUser),
  filtersState: Filters.Model,
  overviewState: Overview.Model,
  tripsState: Trips.Model,
  savedViewsState: SavedViews.Model,
  genieState: Genie.Model,
  gpsState: Gps.Model,
  analysisRunsState: AnalysisRuns.Model,
});
export type Model = typeof Model.Type;
export const navigation = [
  {
    path: pagePaths.Overview,
    label: "Trip overview",
    icon: "layout-dashboard",
  },
  { path: pagePaths.Trips, label: "Trip explorer", icon: "table-2" },
  { path: pagePaths.TripMap, label: "Trip map", icon: "map" },
  { path: pagePaths.AnalysisRuns, label: "Analysis runs", icon: "activity" },
] as const;
