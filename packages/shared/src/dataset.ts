import { Schema } from "effect";

export const DatasetMetadata = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  trips: Schema.Natural,
});
