import { Effect, Queue, Schema, Stream, SubscriptionRef } from "effect";
import { Command, Mount } from "foldkit";
import { GpsEndpoint } from "../../../../shared/map-dataset";
import { Filters } from "../../../../shared/filters";
import { done } from "../../lib/command-result";
import { Message as M } from "./messages";

export const gpsHostId = "gps-density-map";
const MapData = Schema.Struct({
  query: Schema.String,
  filters: Filters,
  endpoint: GpsEndpoint,
  revision: Schema.Int,
  key: Schema.String,
  loading: Schema.Boolean,
  selected: Schema.NullOr(Schema.String),
});
export type MapData = typeof MapData.Type;
export type MapEvent =
  | ReturnType<typeof M.LoadedGps>
  | ReturnType<typeof M.GpsReady>
  | ReturnType<typeof M.GpsSelect>;
const inputsByHost = new WeakMap<
  Element,
  SubscriptionRef.SubscriptionRef<MapData>
>();
export const RefreshGps = Command.define("RefreshGps", {
  args: MapData.fields,
  messages: [M.Idle],
  execute: (data) =>
    done(
      Effect.gen(function* () {
        const host = document.getElementById(gpsHostId);
        const inputs = host && inputsByHost.get(host);
        if (inputs) yield* SubscriptionRef.set(inputs, data);
      }),
    ),
});
export const GpsMount = Mount.defineStream("GpsMap", {
  args: MapData.fields,
  messages: [M.LoadedGps, M.GpsReady, M.GpsSelect],
  execute: ({ element, viewStateChanges, ...initial }) =>
    Stream.callback<MapEvent>((queue) =>
      Effect.gen(function* () {
        const inputs = yield* SubscriptionRef.make<MapData>(initial);
        yield* Effect.acquireRelease(
          Effect.sync(() => inputsByHost.set(element, inputs)),
          () => Effect.sync(() => inputsByHost.delete(element)),
        );
        yield* Effect.gen(function* () {
          if (!(element instanceof HTMLElement))
            return yield* Effect.fail(
              "GPS map container unavailable. Try again.",
            );
          const renderer = yield* Effect.tryPromise({
            try: () => import("./renderer"),
            catch: () => "Unable to load the GPS map. Try again.",
          });
          yield* renderer.mountGpsMap(element, inputs, viewStateChanges, queue);
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const latest = yield* SubscriptionRef.get(inputs);
              Queue.offerUnsafe(
                queue,
                M.GpsReady({
                  key: latest.key,
                  error,
                }),
              );
            }),
          ),
        );
      }),
    ),
});
