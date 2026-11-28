import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { UserIdentity } from "@dsiem/analytics/contracts";
import { DatasetMetadata } from "@dsiem/analytics-shared/dataset";
import * as AnalysisRuns from "../features/analysis-runs/model";
import * as Filters from "../features/filters/model";
import * as Genie from "../features/genie/model";
import * as Gps from "../features/gps/model";
import * as Overview from "../features/overview/model";
import * as SavedViews from "../features/saved-views/model";
import * as Trips from "../features/trips/model";
import { Notice } from "../lib/request-state";
import * as Layout from "./layout";
import { Location, pageUrls } from "./route";
import * as Theme from "./theme";
export const Model = Schema.Struct({
  location: Location,
  layout: Layout.Model,
  theme: Theme.Model,
  metadata: AsyncData.Schema(DatasetMetadata, Notice).schema,
  user: Schema.Option(UserIdentity),
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
    path: pageUrls.Overview,
    label: "Trip overview",
    icon: "layout-dashboard",
  },
  { path: pageUrls.Trips, label: "Trip explorer", icon: "table-2" },
  { path: pageUrls.TripMap, label: "Trip map", icon: "map" },
  { path: pageUrls.AnalysisRuns, label: "Analysis runs", icon: "activity" },
] as const;
