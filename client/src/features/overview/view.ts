import { AsyncData } from "foldkit";
import { defineView } from "foldkit/submodel";
import type { Filters } from "@dsiem/analytics-shared/filters";
import type { Overview } from "@dsiem/analytics-shared/overview";
import { metricGrid, recordTable, seriesChart } from "@dsiem/workbench-ui";
import { ask } from "../../domain/analysis";
import { href, queryFor } from "../../domain/filters";
import { money, number } from "../../lib/format";
import { icon } from "../../ui/icons";
import {
  button,
  type Child,
  card,
  error,
  loading,
  panelHeader,
  title,
} from "../../ui/primitives";
import {
  dailyChartContext,
  hourlyChartContext,
  zonesChartContext,
} from "./context";
import { MetricTabs } from "./metric-tabs";
import { dailySeries, hourlySeries, tripMetrics } from "./report";
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
  const dailyChart = dailySeries(series);
  return [
    metricGrid(h, summary, tripMetrics(h)),
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
                            title: dailyChart.title,
                            description: "Activity over the selected period",
                            actions: [
                              ask(
                                h,
                                (context, question) =>
                                  M.Analyze({ context, question }),
                                `Ask Genie about ${dailyChart.title.toLowerCase()}`,
                                dailyChartContext(
                                  dailyChart.title,
                                  data,
                                  series,
                                ),
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
                              seriesChart(h, daily, {
                                ...dailyChart,
                                width: mobile ? 400 : 700,
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
                  title: hourlySeries.title,
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
                seriesChart(h, hourly, hourlySeries),
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
                recordTable(h, zones.slice(0, 5), {
                  caption: "Top pickup ZIP codes",
                  key: (zone) => zone.zip,
                  columns: [
                    { header: "Pickup ZIP", cell: (zone) => zone.zip },
                    { header: "Trips", cell: (zone) => number(zone.trips) },
                    {
                      header: "Fare revenue",
                      cell: (zone) => money(zone.revenue),
                    },
                    {
                      header: "Avg. fare",
                      cell: (zone) => money(zone.avg_fare, 2),
                    },
                    {
                      header: "Explore",
                      cell: (zone) =>
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
                    },
                  ],
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
