import { Option } from "effect";
import type { GenieContext } from "@dsiem/analytics-shared/genie";
import { gpsContext } from "../features/gps/context";
import { overviewContext } from "../features/overview/context";
import type { Model } from "./model";
import { AppRoute } from "./route";

const workspaceContext = (): GenieContext => ({
  page: "genie",
  title: "Taxi trip data",
});

export const pageContext = (model: Model): GenieContext => {
  const { route, filters } = model.location;
  return AppRoute.match<GenieContext>(route, {
    TripMap: () =>
      gpsContext(
        model.gpsState,
        Option.getOrElse(filters, () => ({})),
      ),
    Overview: () => overviewContext(model.overviewState),
    Trips: () => ({ page: "trips", title: "Trip records" }),
    Genie: workspaceContext,
    AnalysisRuns: workspaceContext,
    NotFound: workspaceContext,
  });
};
