import type { Overview } from "@dsiem/analytics-shared/overview";
import type { H, Metric, Series } from "@dsiem/workbench-ui";
import { icon } from "../../ui/icons";
import { compact, money, number } from "../../lib/format";
import type { Model } from "./model";

export const tripMetrics = <Message>(
  h: H<Message>,
): ReadonlyArray<Metric<Overview["summary"]>> => [
  {
    label: "Total trips",
    value: (row) => number(row.trips),
    detail: "Recorded taxi trips",
    icon: icon(h, "car-taxi-front"),
  },
  {
    label: "Total fare revenue",
    value: (row) => money(row.revenue),
    detail: "USD · excludes tips & tolls",
    icon: icon(h, "circle-dollar-sign"),
  },
  {
    label: "Average fare",
    value: (row) => money(row.avg_fare, 2),
    detail: "Per recorded trip",
    icon: icon(h, "activity"),
  },
  {
    label: "Average distance",
    value: (row) => `${row.avg_distance.toFixed(2)} mi`,
    detail: (row) => `${row.avg_duration.toFixed(1)} min average duration`,
    icon: icon(h, "route"),
  },
];

const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function dailySeries(
  series: Model["series"],
): Series<Overview["daily"][number]> {
  return {
    kind: "area",
    title:
      series === "trips"
        ? "Trips by pickup date"
        : "Fare revenue by pickup date",
    label: (row) => {
      const timestamp = Date.parse(row.day);
      return Number.isFinite(timestamp) ? dayLabel.format(timestamp) : row.day;
    },
    value: (row) => row[series],
    formatValue: series === "revenue" ? (value) => money(value, 2) : number,
    formatTick: series === "revenue" ? money : compact,
  };
}

export const hourlySeries: Series<Overview["hourly"][number]> = {
  kind: "bar",
  title: "Trips by pickup hour",
  label: (row) => `${row.hour % 12 || 12} ${row.hour < 12 ? "am" : "pm"}`,
  value: (row) => row.trips,
  width: 400,
};
