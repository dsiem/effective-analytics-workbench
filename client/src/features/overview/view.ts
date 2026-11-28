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
  const busiestHour = hourly.reduce<(typeof hourly)[number] | undefined>(
    (peak, row) => (!peak || row.trips > peak.trips ? row : peak),
    undefined,
  );
  const leadingZones = zones.slice(0, 5);
  const leadingTrips = leadingZones.reduce((sum, zone) => sum + zone.trips, 0);
  const leadingShare = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(leadingTrips / (summary.trips || 1));
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
              card(
                h,
                [
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
                              description:
                                series === "trips"
                                  ? "Daily pickup volume"
                                  : "Daily fare revenue in USD",
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
                ],
                "daily-chart",
              ),
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
                  busiestHour
                    ? [
                        h.span([], ["Peak hour"]),
                        h.strong(
                          [],
                          [
                            `${hourlySeries.label(busiestHour)} · ${number(busiestHour.trips)} trips`,
                          ],
                        ),
                      ]
                    : ["Hours as recorded in the source"],
                ),
              ]),
            ],
          ),
          h.div(
            [h.Class("dashboard-grid")],
            [
              card(
                h,
                [
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
                  recordTable(h, leadingZones, {
                    caption: "Top pickup ZIP codes",
                    key: (zone) => zone.zip,
                    columns: [
                      { header: "Pickup ZIP", cell: (zone) => zone.zip },
                      {
                        header: "Trips",
                        cell: (zone) =>
                          h.span(
                            [h.Class("ranked-volume")],
                            [
                              h.span([], [number(zone.trips)]),
                              h.span(
                                [h.Class("ranked-track"), h.AriaHidden(true)],
                                [
                                  h.span(
                                    [
                                      h.Style({
                                        width: `${(100 * zone.trips) / (leadingZones[0]?.trips || 1)}%`,
                                      }),
                                    ],
                                    [],
                                  ),
                                ],
                              ),
                            ],
                          ),
                      },
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
                ],
                "zip-ranking",
              ),
              card(
                h,
                [
                  h.h2([], ["Pickup concentration"]),
                  ...(leadingZones.length
                    ? [
                        h.p([h.Class("concentration-value")], [leadingShare]),
                        h.div(
                          [h.Class("concentration-track"), h.AriaHidden(true)],
                          [h.span([h.Style({ width: leadingShare })], [])],
                        ),
                      ]
                    : []),
                  h.p(
                    [],
                    [
                      leadingZones.length
                        ? `${number(leadingTrips)} of ${number(summary.trips)} trips started in ${leadingZones.length === 1 ? "the leading pickup ZIP code" : `the top ${leadingZones.length} pickup ZIP codes`}.`
                        : "No ranked pickup ZIP codes for this selection.",
                    ],
                  ),
                  button(h, {
                    label: h.span(
                      [h.Class("inline-flex items-center gap-2")],
                      ["Explore with Genie", icon(h, "arrow-up-right")],
                    ),
                    onClick: M.Analyze({
                      context: zonesChartContext(data),
                      question:
                        "Compare pickup concentration across ZIP codes for this view.",
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
