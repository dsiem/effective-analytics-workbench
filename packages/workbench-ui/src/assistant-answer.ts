import { Schema } from "effect";

export const AssistantAnswer = Schema.Struct({
  continuation: Schema.String,
  text: Schema.Array(Schema.String),
  tables: Schema.Array(
    Schema.Struct({
      columns: Schema.Array(Schema.String),
      rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
      truncated: Schema.Boolean,
    }),
  ),
});
