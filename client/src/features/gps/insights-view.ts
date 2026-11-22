import type { GpsEndpoint, MapSummary } from "../../../../shared/map-dataset";
import { compact, money, number } from "../../lib/format";
import { button, card } from "../../ui/primitives";
import { endpointName, type Model } from "./model";
import { type H, Message as M } from "./view-messages";

function tripCoverage(h: H, endpoint: GpsEndpoint, data: MapSummary | null) {
  const matching = data?.matchingTrips ?? 0;
  const located = data?.locatedTrips ?? 0;
  return card(
    h,
    [
      h.p([h.Class("muted text-xs")], [`Recorded ${endpointName(endpoint)}`]),
      h.p([h.Class("gps-total")], [compact(located)]),
      h.p(
        [h.Class("muted text-xs mt-2")],
        [
          `${number(matching - located)} trips have no usable ${endpoint === "pickup" ? "pickup" : "drop-off"} GPS in the NYC region.`,
        ],
      ),
      ...(data?.truncated
        ? [
            h.p(
              [h.Class("muted text-xs mt-2")],
              [
                `Showing the ${number(data.loaded)} busiest of ${number(data.totalCells)} areas, covering ${number(data.shownTrips)} locations.`,
              ],
            ),
          ]
        : []),
    ],
    "p-5",
  );
}

function selectedArea(h: H, selected: Model["selectedCell"]) {
  const metric = (label: string, value: string) =>
    h.div(
      [],
      [
        h.dt([h.Class("muted text-xs")], [label]),
        h.dd([h.Class("gps-value")], [value]),
      ],
    );
  return card(
    h,
    selected
      ? [
          h.div(
            [h.Class("flex items-center justify-between gap-2 mb-4")],
            [
              h.h2([], ["Selected area"]),
              button(h, {
                label: "Clear",
                onClick: M.GpsSelect({ id: null }),
                variant: "ghost",
              }),
            ],
          ),
          h.p(
            [h.Class("muted text-xs mb-4")],
            [
              selected.zip
                ? `Common ZIP area ${selected.zip}`
                : "Outside ZIP-area coverage",
            ],
          ),
          h.dl(
            [h.Class("gps-metrics")],
            [
              metric("Trips", number(selected.trips)),
              metric("Average fare", money(selected.avg_fare, 2)),
              metric(
                "Average distance",
                `${selected.avg_distance.toFixed(1)} mi`,
              ),
              metric(
                "Area center",
                `${selected.latitude.toFixed(3)}, ${selected.longitude.toFixed(3)}`,
              ),
            ],
          ),
          h.p(
            [h.Class("muted text-xs mt-4")],
            [
              "Fare excludes tips and tolls. This area can span more than one ZIP code.",
            ],
          ),
        ]
      : [
          h.h2([], ["Explore an area"]),
          h.p(
            [h.Class("muted text-sm mt-2")],
            [
              "Select a hexagon on the map, or choose one of the busiest areas below.",
            ],
          ),
        ],
    "p-5",
  );
}

function busiestAreas(h: H, model: Model) {
  const data = model.activity.data;
  return card(
    h,
    [
      h.h2([], ["Busiest areas"]),
      h.div(
        [h.Class("mt-3")],
        (data?.cells ?? [])
          .slice(0, 5)
          .map((cell, index) =>
            h.button(
              [
                h.Key(cell.id),
                h.Class("gps-area"),
                h.OnClick(M.GpsSelect({ id: cell.id })),
                h.AriaPressed(String(cell.id === model.selected)),
                h.AriaLabel(
                  `Area ${index + 1}, ${number(cell.trips)} ${endpointName(model.endpoint)}`,
                ),
              ],
              [
                h.span([h.Class("rank")], [String(index + 1)]),
                h.span(
                  [h.Class("gps-area-label")],
                  [
                    h.span(
                      [],
                      [cell.zip ? `Near ${cell.zip}` : "Outside ZIP coverage"],
                    ),
                    h.small(
                      [h.Class("muted")],
                      [
                        `${cell.latitude.toFixed(3)}, ${cell.longitude.toFixed(3)}`,
                      ],
                    ),
                  ],
                ),
                h.span(
                  [h.Class("text-sm font-semibold")],
                  [compact(cell.trips)],
                ),
              ],
            ),
          ),
      ),
      ...(!data?.locatedTrips
        ? [
            h.p(
              [h.Class("muted text-sm mt-2")],
              ["No recorded GPS locations match these filters."],
            ),
          ]
        : []),
    ],
    "p-5",
  );
}

export function mapInsights(h: H, model: Model) {
  return h.aside(
    [
      h.Class("gps-insights"),
      h.AriaLabel("GPS map insights"),
      h.AriaBusy(model.activity.loading),
    ],
    model.activity.loading
      ? [card(h, [h.p([h.Class("muted text-sm")], ["Updating map…"])], "p-5")]
      : [
          tripCoverage(h, model.endpoint, model.activity.data),
          selectedArea(h, model.selectedCell),
          busiestAreas(h, model),
          h.p(
            [h.Class("muted text-xs")],
            [
              "Dates and ZIP filters apply to pickups, including when viewing drop-offs. Locations are recorded endpoints, not driving routes.",
            ],
          ),
        ],
  );
}
