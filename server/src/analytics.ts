import { Context, Effect, Layer } from "effect";
import type { DatasetMetadata } from "../../shared/dataset.js";
import type { Filters } from "../../shared/filters.js";
import type { GpsSearch, TripMap } from "../../shared/map-dataset.js";
import type { Overview } from "../../shared/overview.js";
import type { Trip, TripSearch } from "../../shared/trips.js";
import type {
  InvalidRequest,
  ServiceUnavailable,
  OperationTimeout,
  PermissionDenied,
  TripNotFound,
} from "./errors.js";
import { makeOverview } from "./taxi/overview.js";
import { makeTripMap } from "./taxi/trip-map.js";
import { makeTrips } from "./taxi/trips.js";
import { Warehouse } from "./warehouse.js";

type WarehouseError =
  | ServiceUnavailable<"warehouse">
  | OperationTimeout<"warehouse">
  | PermissionDenied;

export class Analytics extends Context.Service<
  Analytics,
  {
    readonly metadata: Effect.Effect<
      typeof DatasetMetadata.Type,
      WarehouseError
    >;
    readonly overview: (
      filters: Filters,
    ) => Effect.Effect<Overview, WarehouseError>;
    readonly trips: (
      search: TripSearch,
    ) => Effect.Effect<Uint8Array, WarehouseError>;
    readonly tripPage: (
      cursor: string,
    ) => Effect.Effect<Uint8Array, WarehouseError | InvalidRequest>;
    readonly tripDetails: (
      tripId: Trip["trip_id"],
    ) => Effect.Effect<Trip, WarehouseError | TripNotFound>;
    readonly tripMap: (
      search: typeof GpsSearch.Type,
    ) => Effect.Effect<TripMap, WarehouseError>;
  }
>()("app/Analytics") {
  static readonly layer = Layer.effect(
    Analytics,
    Effect.gen(function* () {
      const warehouse = yield* Warehouse;
      const { metadata, overview } = yield* makeOverview(warehouse);
      const { trips, tripPage, tripDetails } = yield* makeTrips(warehouse);
      const tripMap = yield* makeTripMap(warehouse);
      return { metadata, overview, trips, tripPage, tripDetails, tripMap };
    }),
  );
}
