import {
  genieContextDataLimit,
  type GenieContext,
} from "../../../../shared/genie";
import type { Overview } from "../../../../shared/overview";
import type { Model } from "./model";

function snapshot(
  title: string,
  overview: Overview,
  data: string,
): GenieContext {
  return {
    page: "overview",
    title,
    data:
      data.length <= genieContextDataLimit
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
    daily: [],
  };
  let remaining = genieContextDataLimit - JSON.stringify(details).length;
  let start = rows.length;
  // Account for each encoded row and its comma before adding it to the JSON array.
  for (let i = rows.length - 1; i >= 0; i--) {
    const length =
      JSON.stringify(rows[i]).length + (start < rows.length ? 1 : 0);
    if (length > remaining) break;
    remaining -= length;
    start = i;
  }
  return snapshot(
    title,
    overview,
    JSON.stringify({ ...details, daily: rows.slice(start) }),
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
  const overview = model.overview.data;
  return overview && !model.overview.error
    ? dailySnapshot("Trip overview", overview, model.series, "page")
    : { page: "overview", title: "Trip overview" };
}
