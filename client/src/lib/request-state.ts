import { Schema } from "effect";

export const AccessDenied = Schema.TaggedStruct("AccessDenied", {
  message: Schema.String,
});
export const Notice = Schema.Union([Schema.String, AccessDenied]);
export type Notice = typeof Notice.Type;
