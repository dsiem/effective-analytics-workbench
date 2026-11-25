import { AsyncData } from "foldkit";
import { defineView } from "foldkit/submodel";
import type { Filters } from "@dsiem/analytics-shared/filters";
import type { Overview } from "@dsiem/analytics-shared/overview";
import { ask } from "../../domain/analysis";
import { href, queryFor } from "../../domain/filters";
import { compact, money, number } from "../../lib/format";
import { chart } from "../../ui/chart";
import { icon } from "../../ui/icons";
import {
  button,
  type Child,
  card,
  error,
  loading,
  metric,
  panelHeader,
  table,
  title,
} from "../../ui/primitives";
import {
  dailyChartContext,
  hourlyChartContext,
  zonesChartContext,
} from "./context";
import { MetricTabs } from "./metric-tabs";
import type { Model } from "./model";
import type { H } from "./view-messages";
import { Message as M } from "./view-messages";

type ViewInputs = {
  readonly query: string;
  readonly filters: Filters;
  readonly mobile: boolean;
};

function overviewData(
  h: H,
  model: Model,
  { query, filters, mobile }: ViewInputs,
  data: Overview,
): Child[] {
  const { summary, daily, hourly, zones, queriedAt } = data;
  const series = model.series;
  const dailyTitle =
    series === "trips" ? "Trips by pickup date" : "Fare revenue by pickup date";
  return [
    h.div(
      [h.Class("metrics")],
      [
        metric(h, {
          label: "Total trips",
          value: number(summary.trips),
          detail: "Recorded taxi trips",
          icon: icon(h, "car-taxi-front"),
        }),
        metric(h, {
          label: "Total fare revenue",
          value: money(summary.revenue),
          detail: "USD · excludes tips & tolls",
          icon: icon(h, "circle-dollar-sign"),
        }),
        metric(h, {
          label: "Average fare",
          value: money(summary.avg_fare, 2),
          detail: "Per recorded trip",
          icon: icon(h, "activity"),
        }),
        metric(h, {
          label: "Average distance",
          value: `${summary.avg_distance.toFixed(2)} mi`,
          detail: `${summary.avg_duration.toFixed(1)} min average duration`,
          icon: icon(h, "route"),
        }),
      ],
    ),
    ...(summary.trips === 0
      ? [
          card(
            h,
            ["No pickups here. Try another ZIP code or a wider date range."],
            "p-10 text-center muted",
          ),
        ]
      : [
          h.div(
            [h.Class("dashboard-grid")],
            [
              card(h, [
                h.submodel({
                  slotId: "daily-metric",
                  view: MetricTabs.view,
                  model: model.metricTabs,
                  toParentMessage: (message) =>
                    M.GotMetricTabsMessage({ message }),
                  viewInputs: {
                    tabs: ["trips", "revenue"],
                    selectedValue: series,
                    ariaLabel: "Daily chart metric",
                    toView: ({ tablist, tabs, activeIndex }) =>
                      h.div(
                        [h.DataAttribute("slot", "tabs")],
                        [
                          panelHeader(h, {
                            title: dailyTitle,
                            description: "Activity over the selected period",
                            actions: [
                              ask(
                                h,
                                (context, question) =>
                                  M.Analyze({ context, question }),
                                `Ask Genie about ${dailyTitle.toLowerCase()}`,
                                dailyChartContext(dailyTitle, data, series),
                                "Explain the pattern in this chart and highlight any unusual days.",
                              ),
                              h.div(
                                [...tablist, h.Class("tabs")],
                                tabs.map((tab) =>
                                  h.button(
                                    [...tab.tab, h.Class("tab")],
                                    [
                                      tab.value === "trips"
                                        ? "Trips"
                                        : "Revenue",
                                    ],
                                  ),
                                ),
                              ),
                            ],
                          }),
                          h.div(
                            [...(tabs[activeIndex]?.panel ?? [])],
                            [
                              chart(h, {
                                kind: "area",
                                width: mobile ? 400 : 700,
                                title: dailyTitle,
                                data: daily.map((row) => ({
                                  label: row.day.slice(5),
                                  value: row[series],
                                })),
                                formatValue:
                                  series === "revenue"
                                    ? (value) => money(value, 2)
                                    : number,
                                formatTick:
                                  series === "revenue" ? money : compact,
                              }),
                            ],
                          ),
                        ],
                      ),
                  },
                }),
                h.div(
                  [h.Class("panel-footer")],
                  [
                    h.span([], ["NYC yellow taxis"]),
                    h.span([], [`${daily.length} days with recorded trips`]),
                  ],
                ),
              ]),
              card(h, [
                panelHeader(h, {
                  title: "Trips by pickup hour",
                  description: "Distribution across the day",
                  actions: [
                    ask(
                      h,
                      (context, question) => M.Analyze({ context, question }),
                      "Ask Genie about pickup hours",
                      hourlyChartContext(data),
                      "Explain this hourly pickup pattern. Which hours stand out?",
                    ),
                  ],
                }),
                chart(h, {
                  kind: "bar",
                  title: "Trips by pickup hour",
                  width: 400,
                  data: hourly.map((row) => ({
                    label: `${row.hour}:00`,
                    value: row.trips,
                  })),
                }),
                h.p(
                  [h.Class("panel-footer")],
                  ["Hours as recorded in the source"],
                ),
              ]),
            ],
          ),
          h.div(
            [h.Class("dashboard-grid")],
            [
              card(h, [
                panelHeader(h, {
                  title: "Top pickup ZIP codes",
                  description: "Pickup areas ranked by trip volume",
                  actions: [
                    ask(
                      h,
                      (context, question) => M.Analyze({ context, question }),
                      "Ask Genie about top pickup ZIP codes",
                      zonesChartContext(data),
                      "Compare these pickup ZIP codes by trip volume and average fare.",
                    ),
                    h.a(
                      [
                        h.Href(href("/trip-map", query)),
                        h.Class("btn btn-small"),
                        h.AriaLabel("View pickup map"),
                      ],
                      [icon(h, "map"), "Map"],
                    ),
                  ],
                }),
                table(h, {
                  caption: "Top pickup ZIP codes",
                  headers: [
                    "Pickup ZIP",
                    "Trips",
                    "Fare revenue",
                    "Avg. fare",
                    "Explore",
                  ],
                  rows: zones.slice(0, 5).map((zone) => ({
                    key: zone.zip,
                    cells: [
                      zone.zip,
                      number(zone.trips),
                      money(zone.revenue),
                      money(zone.avg_fare, 2),
                      h.a(
                        [
                          h.Href(
                            href(
                              "/trips",
                              queryFor({
                                ...filters,
                                zip: zone.zip,
                              }),
                            ),
                          ),
                          h.AriaLabel(`View trips in ${zone.zip}`),
                          h.Class("btn btn-ghost btn-icon"),
                        ],
                        [icon(h, "arrow-up-right")],
                      ),
                    ],
                  })),
                }),
              ]),
              card(
                h,
                [
                  h.span([h.Class("icon-tile")], [icon(h, "sparkles")]),
                  h.h2([], ["Take the next analytical step"]),
                  h.p(
                    [],
                    [
                      "Compare periods, investigate unusual fares, or uncover a pattern. Genie uses the filters and data in this view to help you go further.",
                    ],
                  ),
                  button(h, {
                    label: h.span(
                      [h.Class("inline-flex items-center gap-2")],
                      ["Explore with Genie", icon(h, "arrow-up-right")],
                    ),
                    onClick: M.Analyze({
                      context: null,
                      question:
                        "Compare weekday and weekend trip activity for this view.",
                    }),
                    variant: "primary",
                  }),
                ],
                "insight-card",
              ),
            ],
          ),
        ]),
    h.p(
      [h.Class("muted text-xs text-right mt-4")],
      [`Queried ${new Date(queriedAt).toLocaleTimeString()}`],
    ),
  ];
}

export const overviewView = defineView<Model, typeof M.Type, ViewInputs>(
  (model, inputs, h) => {
    const loadingOverview = () => [loading(h)];
    const loadError = (notice: Parameters<typeof error>[1]) => [
      error(h, notice, M.Reload()),
    ];
    return h.div(
      [h.Class("contents")],
      [
        title(
          h,
          "Trip overview",
          "Trip activity, fares, and pickup patterns at a glance.",
        ),
        ...AsyncData.match(model.overview, {
          onIdle: () => [],
          onLoading: loadingOverview,
          onRefreshing: loadingOverview,
          onFailure: loadError,
          onStale: ({ error }) => loadError(error),
          onSuccess: (data) => overviewData(h, model, inputs, data),
        }),
      ],
    );
  },
);
