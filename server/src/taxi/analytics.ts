import { Context, Effect, Layer } from "effect";
import type { DatasetMetadata } from "@dsiem/analytics-shared/dataset";
import type { Filters } from "@dsiem/analytics-shared/filters";
import type { GpsSearch, TripMap } from "@dsiem/analytics-shared/map-dataset";
import type { Overview } from "@dsiem/analytics-shared/overview";
import type { Trip, TripSearch } from "@dsiem/analytics-shared/trips";
import type {
  InvalidRequest,
  ServiceUnavailable,
  OperationTimeout,
  PermissionDenied,
  TripNotFound,
} from "../errors.js";
import { Settings } from "../settings.js";
import { Warehouse } from "../warehouse.js";
import { makeOverview } from "./overview.js";
import { makeTaxiSnapshot } from "./snapshot.js";
import { makeTripMap } from "./trip-map.js";
import { makeTrips } from "./trips.js";

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
      const { tripSnapshotTable } = yield* Settings;
      const snapshot = makeTaxiSnapshot(warehouse, tripSnapshotTable);
      const { metadata, overview } = yield* makeOverview(snapshot);
      const { trips, tripPage, tripDetails } = yield* makeTrips(snapshot);
      const tripMap = yield* makeTripMap(snapshot);
      return { metadata, overview, trips, tripPage, tripDetails, tripMap };
    }),
  );
}
