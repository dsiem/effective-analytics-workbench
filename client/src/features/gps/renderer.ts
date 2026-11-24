import { PolygonLayer } from "@deck.gl/layers";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import {
  Deferred,
  Effect,
  Queue,
  Result,
  Stream,
  SubscriptionRef,
} from "effect";
import type { Mount } from "foldkit";
import {
  Map as LibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { failure } from "../../lib/command-result";
import { mapColors } from "../../lib/map-colors";
import { activityBucket, pickedIndex, type MapResource } from "./dataset";
import { mapLoads } from "./load";
import { Message as M } from "./messages";
import { dataKey } from "./model";
import type { MapData, MapEvent } from "./mount";

setWorkerUrl(workerUrl);
const number = new Intl.NumberFormat("en-US");
const renderError =
  "Unable to render the GPS map. Check WebGL support and try again.";
export function mountGpsMap(
  element: HTMLElement,
  inputs: SubscriptionRef.SubscriptionRef<MapData>,
  viewStates: Stream.Stream<Mount.ViewState>,
  queue: Queue.Enqueue<MapEvent>,
) {
  return Effect.gen(function* () {
    const styled = yield* Deferred.make<void>();
    const map = yield* Effect.acquireRelease(
      Effect.try(
        () =>
          new LibreMap({
            container: element,
            center: [-73.94, 40.735],
            zoom: 10.3,
            minZoom: 8,
            maxZoom: 16,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            style: {
              version: 8,
              sources: {
                streets: {
                  type: "raster",
                  tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                  tileSize: 256,
                  maxzoom: 19,
                  attribution:
                    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                },
              },
              layers: [
                {
                  id: "streets",
                  type: "raster",
                  source: "streets",
                  paint: {
                    "raster-saturation": -1,
                    "raster-brightness-max-transition": {
                      duration: 0,
                      delay: 0,
                    },
                  },
                },
              ],
            },
          }),
      ),
      (map) =>
        Effect.sync(() => {
          map.remove();
          element.inert = false;
        }),
    );
    map.once("style.load", () => Deferred.doneUnsafe(styled, Effect.void));
    yield* Deferred.await(styled);
    let data = yield* SubscriptionRef.get(inputs);
    yield* Effect.try(() => {
      let resource: MapResource | undefined;
      let rendered: MapData | undefined;
      let live = false;
      const popup = new Popup({
        closeButton: false,
        closeOnClick: false,
        className: "map-tooltip gps-tooltip",
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-left");
      map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      const interaction = () => {
        const enabled =
          live && !!resource && !data.loading && rendered === data;
        element.inert = !enabled;
        for (const handler of [
          map.dragPan,
          map.scrollZoom,
          map.doubleClickZoom,
          map.boxZoom,
          map.keyboard,
          map.touchZoomRotate,
        ]) {
          if (enabled) handler.enable();
          else handler.disable();
        }
        if (!enabled) popup.remove();
      };
      const deck = new MapLibreOverlay({
        onAfterRender: () => {
          if (!resource || data.loading || rendered === data) return;
          rendered = data;
          interaction();
          Queue.offerUnsafe(
            queue,
            M.GpsReady({
              key: data.key,
              error: "",
              selectedCell: data.selected
                ? (resource.cell(resource.index(data.selected)) ?? null)
                : null,
            }),
          );
        },
        onError: () =>
          Queue.offerUnsafe(
            queue,
            M.GpsReady({
              key: data.key,
              error: renderError,
            }),
          ),
      });
      map.addControl(deck);
      const redraw = () => {
        const colors = mapColors(element);
        const maximum = resource?.cell(0)?.trips || 1;
        const selectedIndex = data.selected
          ? (resource?.index(data.selected) ?? -1)
          : -1;
        const selected =
          selectedIndex >= 0 ? [resource?.ring(selectedIndex) ?? []] : [];
        const color = (trips: number) =>
          colors.activity[activityBucket(trips, maximum)] ?? colors.subtle;
        map.setPaintProperty(
          "streets",
          "raster-brightness-max",
          document.documentElement.classList.contains("dark") ? 0.4 : 1,
        );
        map
          .getCanvas()
          .setAttribute(
            "aria-label",
            `GPS ${data.endpoint === "pickup" ? "pickup" : "drop-off"} density`,
          );
        deck.setProps({
          layers: [
            new PolygonLayer({
              id: "gps-cells",
              data: resource?.rows ?? [],
              getPolygon: (cell) => cell.boundary.coordinates[0] ?? [],
              filled: true,
              stroked: false,
              pickable: true,
              opacity: 0.35,
              getFillColor: (cell) => color(cell.trips),
              autoHighlight: true,
              highlightColor: [190, 150, 70, 90],
              updateTriggers: { getFillColor: [colors, maximum] },
            }),
            new PolygonLayer({
              id: "gps-selection-halo",
              data: selected,
              getPolygon: (ring) => ring,
              filled: false,
              stroked: true,
              getLineColor: colors.surface,
              getLineWidth: 6,
              lineWidthUnits: "pixels",
              updateTriggers: { getLineColor: [colors] },
            }),
            new PolygonLayer({
              id: "gps-selection",
              data: selected,
              getPolygon: (ring) => ring,
              filled: false,
              stroked: true,
              getLineColor: colors.activity[4] ?? colors.surface,
              getLineWidth: 2,
              lineWidthUnits: "pixels",
              updateTriggers: { getLineColor: [colors] },
            }),
          ],
        });
      };
      const pick = (x: number, y: number) => {
        const hit = deck.pickObject({ x, y, radius: 2 });
        return hit?.layer && resource
          ? resource.cell(pickedIndex(resource, hit.layer.id, hit.index))
          : undefined;
      };
      map.on("mousemove", (event) => {
        if (element.inert) return;
        const cell = pick(event.point.x, event.point.y);
        map.getCanvas().style.cursor = cell ? "pointer" : "";
        if (cell)
          popup
            .setLngLat(event.lngLat)
            .setText(
              `${number.format(cell.trips)} ${data.endpoint === "pickup" ? "pickups" : "drop-offs"} · $${cell.avg_fare.toFixed(2)} average fare`,
            )
            .addTo(map);
        else popup.remove();
      });
      map.on("mouseout", () => popup.remove());
      map.on("click", (event) => {
        if (element.inert) return;
        const cell = pick(event.point.x, event.point.y);
        if (cell) Queue.offerUnsafe(queue, M.GpsSelect({ id: cell.id }));
      });
      const theme = new MutationObserver(redraw);
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      map.on("remove", () => {
        theme.disconnect();
        popup.remove();
      });
      redraw();
      interaction();
      const changes = SubscriptionRef.changes(inputs).pipe(
        Stream.tap((next) =>
          Effect.try(() => {
            if (next === data) return;
            const focus =
              next.selected !== data.selected
                ? resource?.cell(resource.index(next.selected ?? ""))
                : undefined;
            data = next;
            popup.remove();
            redraw();
            interaction();
            if (focus)
              map.easeTo({
                center: [focus.longitude, focus.latitude],
                zoom: Math.max(map.getZoom(), 12.5),
                duration: 350,
              });
          }),
        ),
      );
      return Effect.all(
        [
          Stream.runForEach(mapLoads(changes), ({ key, result }) =>
            Effect.sync(() => {
              // A completed load can already be queued when the input changes.
              const latest = SubscriptionRef.getUnsafe(inputs);
              if (
                key !== dataKey(latest.query, latest.endpoint, latest.revision)
              )
                return;
              if (Result.isFailure(result)) {
                Queue.offerUnsafe(
                  queue,
                  M.LoadedGps({
                    key,
                    data: null,
                    error: failure(result.failure),
                  }),
                );
                return;
              }
              resource = result.success;
              Queue.offerUnsafe(
                queue,
                M.LoadedGps({ key, data: resource.summary, error: "" }),
              );
              try {
                redraw();
              } catch {
                Queue.offerUnsafe(
                  queue,
                  M.GpsReady({ key: data.key, error: renderError }),
                );
              }
            }),
          ),
          Stream.runForEach(viewStates, (state) =>
            Effect.sync(() => {
              live = state === "Live";
              interaction();
            }),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.flatten);
  }).pipe(Effect.mapError(() => renderError));
}
