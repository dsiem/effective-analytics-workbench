import type { GenieContext } from "@dsiem/analytics-shared/genie";
import { gpsContext } from "../features/gps/context";
import { overviewContext } from "../features/overview/context";
import type { Model } from "./model";
export const pageContext = (model: Model): GenieContext => {
  const { route, filters } = model.location;
  switch (route._tag) {
    case "TripMap":
      return gpsContext(model.gpsState, filters ?? {});
    case "Overview":
      return overviewContext(model.overviewState);
    case "Trips":
      return { page: "trips", title: "Trip records" };
    case "Genie":
    case "AnalysisRuns":
    case "NotFound":
      return { page: "genie", title: "Taxi trip data" };
  }
};
