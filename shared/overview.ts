import { Schema } from "effect";

export const Summary = Schema.Struct({
  trips: Schema.Number,
  revenue: Schema.Number,
  avg_fare: Schema.Number,
  avg_distance: Schema.Number,
  avg_duration: Schema.Number,
});
export const Daily = Schema.Struct({
  day: Schema.String,
  trips: Schema.Number,
  revenue: Schema.Number,
});
export const Hourly = Schema.Struct({
  hour: Schema.Number,
  trips: Schema.Number,
  avg_fare: Schema.Number,
});
export const Zone = Schema.Struct({
  zip: Schema.String,
  trips: Schema.Number,
  revenue: Schema.Number,
  avg_fare: Schema.Number,
});

export const Overview = Schema.Struct({
  summary: Summary,
  daily: Schema.Array(Daily),
  hourly: Schema.Array(Hourly),
  zones: Schema.Array(Zone),
  queriedAt: Schema.String,
});
export type Overview = typeof Overview.Type;
