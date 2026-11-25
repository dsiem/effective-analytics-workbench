import { Schema } from "effect";
import { Count } from "./schema.js";

export const Summary = Schema.Struct({
  trips: Count,
  revenue: Schema.Finite,
  avg_fare: Schema.Finite,
  avg_distance: Schema.Finite,
  avg_duration: Schema.Finite,
});
export const Daily = Schema.Struct({
  day: Schema.String,
  trips: Count,
  revenue: Schema.Finite,
});
export const Hourly = Schema.Struct({
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  trips: Count,
  avg_fare: Schema.Finite,
});
export const Zone = Schema.Struct({
  zip: Schema.String,
  trips: Count,
  revenue: Schema.Finite,
  avg_fare: Schema.Finite,
});

export const Overview = Schema.Struct({
  summary: Summary,
  daily: Schema.Array(Daily),
  hourly: Schema.Array(Hourly),
  zones: Schema.Array(Zone),
  queriedAt: Schema.String,
});
export type Overview = typeof Overview.Type;
