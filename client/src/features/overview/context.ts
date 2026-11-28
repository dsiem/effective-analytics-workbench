import { recentRowsSnapshot } from "@dsiem/genie-client";
import { AsyncData } from "foldkit";
import {
  genieContextDataLimit,
  type GenieContext,
} from "@dsiem/analytics-shared/genie";
import type { Overview } from "@dsiem/analytics-shared/overview";
import type { Model } from "./model";

function snapshot(
  title: string,
  overview: Overview,
  data: string | undefined,
): GenieContext {
  return {
    page: "overview",
    title,
    data:
      data !== undefined && data.length <= genieContextDataLimit
        ? data
        : JSON.stringify({
            scope: "summary-only",
            summary: overview.summary,
            recordedDays: overview.daily.length,
          }),
  };
}

function dailySnapshot(
  title: string,
  overview: Overview,
  metric: Model["series"],
  source: "chart" | "page",
): GenieContext {
  const rows = overview.daily;
  const details = {
    ...(source === "chart"
      ? { metric }
      : {
          summary: overview.summary,
          dailyMetric: metric,
          hourly: overview.hourly,
          topPickupZIPs: overview.zones.slice(0, 5),
        }),
    queriedAt: overview.queriedAt,
    dailyCoverage: {
      recordedDays: rows.length,
      from: rows[0]?.day ?? null,
      to: rows.at(-1)?.day ?? null,
      included: "Most recent recorded days in chronological order",
    },
  };
  return snapshot(
    title,
    overview,
    recentRowsSnapshot({
      fields: details,
      rowsKey: "daily",
      rows,
      maxLength: genieContextDataLimit,
    }),
  );
}

export const dailyChartContext = (
  title: string,
  overview: Overview,
  metric: Model["series"],
) => dailySnapshot(title, overview, metric, "chart");

export const hourlyChartContext = (overview: Overview) =>
  snapshot(
    "Trips by pickup hour",
    overview,
    JSON.stringify({ hourly: overview.hourly, queriedAt: overview.queriedAt }),
  );

export const zonesChartContext = (overview: Overview) =>
  snapshot(
    "Top pickup ZIP codes",
    overview,
    JSON.stringify({
      topPickupZIPs: overview.zones.slice(0, 5),
      queriedAt: overview.queriedAt,
    }),
  );

export function overviewContext(model: Model): GenieContext {
  return AsyncData.isSuccess(model.overview)
    ? dailySnapshot("Trip overview", model.overview.data, model.series, "page")
    : { page: "overview", title: "Trip overview" };
}
