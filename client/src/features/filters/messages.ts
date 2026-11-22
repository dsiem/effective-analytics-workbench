import { DatePicker } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const Message = defineMessageUnion({
  Idle: {},
  FilterChanged: {
    field: Schema.Literals(["from", "to", "zip"]),
    value: Schema.String,
  },
  FilterDatePicker: {
    field: Schema.Literals(["from", "to"]),
    message: DatePicker.Message,
  },
  ApplyFilters: {},
  ResetFilters: {},
  PickZip: { zip: Schema.String },
});
export type Message = typeof Message.Type;
