import type { Tabs } from "@foldkit/ui";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { defineView } from "foldkit/submodel";
import type { GenieContext } from "@dsiem/analytics-shared/genie";
import type { GpsEndpoint } from "@dsiem/analytics-shared/map-dataset";
import { ask } from "../../domain/analysis";
import { activityColors } from "../../lib/map-colors";
import { badge, type Child, card, error, title } from "../../ui/primitives";
import { gpsContext } from "./context";
import { mapInsights } from "./insights-view";
import { dataKey, endpointName, frameKey, type Model } from "./model";
import { GpsMount, gpsHostId, type MapData } from "./mount";
import { EndpointTabs } from "./tabs";
import { type H, Message as M } from "./view-messages";

export type ViewModel = Model & Pick<MapData, "query" | "filters">;

function mapHeader(
  h: H,
  endpoint: GpsEndpoint,
  analysis: GenieContext,
  { tablist, tabs }: Tabs.RenderInfo<GpsEndpoint>,
) {
  return h.div(
    [h.Class("panel-header border-b")],
    [
      h.div(
        [],
        [
          h.h2(
            [],
            [
              endpoint === "pickup"
                ? "Where journeys begin"
                : "Where journeys end",
            ],
          ),
          h.p(
            [h.Class("muted text-xs mt-1")],
            ["Select an area to explore its trips."],
          ),
        ],
      ),
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          h.div(
            [...tablist, h.Class("tabs")],
            tabs.map((tab) =>
              h.button(
                [...tab.tab, h.Class("tab")],
                [tab.value === "pickup" ? "Pickups" : "Drop-offs"],
              ),
            ),
          ),
          ask(
            h,
            (context, question) => M.Analyze({ context, question }),
            "Ask Genie about trip hotspots",
            analysis,
            "Explain the spatial pattern and the selected area, including any limits of this map.",
          ),
        ],
      ),
    ],
  );
}

function mapPanel(
  h: H,
  model: ViewModel,
  { tabs, activeIndex }: Tabs.RenderInfo<GpsEndpoint>,
) {
  const { query, endpoint, revision, filters } = model;
  const selected = Option.getOrNull(model.selected);
  const loading = AsyncData.isPending(model.activity);
  const key = frameKey(query, endpoint, selected, revision);
  const ready = !loading && model.renderedKey === key;
  return h.div(
    [
      ...(tabs[activeIndex]?.panel ?? []),
      h.Class("relative"),
      h.AriaBusy(loading),
    ],
    [
      h.div(
        [
          h.Key(gpsHostId),
          h.Id(gpsHostId),
          h.Class("map-panel gps-panel"),
          h.Role("region"),
          h.AriaLabel(`GPS ${endpointName(endpoint)} density map`),
          h.DataAttribute("gps-ready", String(ready)),
          h.DataAttribute("gps-key", ready ? dataKey(query, endpoint) : ""),
          h.OnMount(
            GpsMount({
              query,
              endpoint,
              revision,
              selected,
              filters,
              key,
              activityTag: model.activity._tag,
            }),
          ),
        ],
        [],
      ),
      ...(loading
        ? [
            h.div(
              [h.Class("map-updating"), h.Role("status")],
              [`Updating ${endpointName(endpoint)}…`],
            ),
          ]
        : []),
    ],
  );
}

function mapCard(h: H, model: ViewModel) {
  const analysis = gpsContext(model, model.filters);
  return card(
    h,
    [
      h.submodel({
        slotId: "gps-endpoint",
        view: EndpointTabs.view,
        model: model.endpointTabs,
        toParentMessage: (message) => M.GotGpsTabsMessage({ message }),
        viewInputs: {
          tabs: ["pickup", "dropoff"],
          selectedValue: model.endpoint,
          ariaLabel: "GPS endpoint",
          toView: (tabs) =>
            h.div(
              [],
              [
                mapHeader(h, model.endpoint, analysis, tabs),
                mapPanel(h, model, tabs),
              ],
            ),
        },
      }),
      h.div(
        [h.Class("panel-footer border-t gps-legend")],
        [
          h.span([], ["Nearby GPS locations grouped into small areas"]),
          h.span(
            [h.Class("flex items-center gap-1")],
            [
              "Fewer",
              ...activityColors.map((color) =>
                h.span(
                  [
                    h.Class("h-2 w-5 rounded-sm"),
                    h.Style({ background: color }),
                  ],
                  [],
                ),
              ),
              "More",
            ],
          ),
        ],
      ),
    ],
    "overflow-hidden",
  );
}

function gpsMap(h: H, model: ViewModel): Child[] {
  const heading = title(
    h,
    "Trip hotspots",
    "See where journeys begin and end, beyond ZIP boundaries.",
    [badge(h, "NYC yellow taxis")],
  );
  const loadError = Option.getOrElse(
    AsyncData.getError(model.activity),
    () => model.mapError,
  );
  if (loadError) return [heading, error(h, loadError, M.Reload())];
  return [
    heading,
    h.div([h.Class("gps-layout")], [mapCard(h, model), mapInsights(h, model)]),
  ];
}
export const gpsMapView = defineView<ViewModel, typeof M.Type>((model, h) =>
  h.div([h.Class("contents")], gpsMap(h, model)),
);
