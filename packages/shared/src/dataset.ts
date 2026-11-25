import { Schema } from "effect";
import { Count } from "./schema.js";

export const DatasetMetadata = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  trips: Count,
});
