import { Schema, Struct } from "effect";
import { filteredSearch } from "./filters.js";
import { Count, Zip } from "./schema.js";

export const GpsEndpoint = Schema.Literals(["pickup", "dropoff"]);
export type GpsEndpoint = typeof GpsEndpoint.Type;
export const GpsSearch = filteredSearch({
  endpoint: Schema.optionalKey(GpsEndpoint),
});

const GpsRing = Schema.mutable(
  Schema.Array(Schema.mutable(Schema.Tuple([Schema.Finite, Schema.Finite]))),
);
export const GpsCell = Schema.Struct({
  id: Schema.String,
  longitude: Schema.Finite,
  latitude: Schema.Finite,
  boundary: Schema.Struct({
    type: Schema.Literal("Polygon"),
    coordinates: Schema.mutable(Schema.Array(GpsRing)),
  }),
  trips: Count,
  avg_fare: Schema.Finite,
  avg_distance: Schema.Finite,
  zip: Schema.NullOr(Zip),
});
export type GpsCell = typeof GpsCell.Type;
export const mapCellLimit = 100_000;
export const TripMap = Schema.Struct({
  endpoint: GpsEndpoint,
  matchingTrips: Count,
  locatedTrips: Count,
  shownTrips: Count,
  totalCells: Count,
  truncated: Schema.Boolean,
  cells: Schema.Array(GpsCell).check(Schema.isMaxLength(mapCellLimit)),
  queriedAt: Schema.String,
});
export type TripMap = typeof TripMap.Type;

export const MapCellSummary = GpsCell.mapFields(Struct.omit(["boundary"]));
export type MapCellSummary = typeof MapCellSummary.Type;
export const MapSummary = Schema.Struct({
  ...Struct.omit(TripMap.fields, ["cells"]),
  loaded: Count,
  cells: Schema.Array(MapCellSummary).check(Schema.isMaxLength(5)),
});
export type MapSummary = typeof MapSummary.Type;
