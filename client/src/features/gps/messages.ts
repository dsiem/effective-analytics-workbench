import { Notice } from "../../lib/request-state";
import { Tabs } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import {
  MapCellSummary,
  MapSummary,
} from "@dsiem/analytics-shared/map-dataset";
export const messages = {
  GpsTabs: { message: Tabs.Message },
  LoadedGps: {
    key: Schema.String,
    data: Schema.NullOr(MapSummary),
    error: Notice,
  },
  GpsReady: {
    key: Schema.String,
    error: Notice,
    selectedCell: Schema.optionalKey(Schema.NullOr(MapCellSummary)),
  },
  GpsSelect: { id: Schema.NullOr(Schema.String) },
};
export const Message = defineMessageUnion({ Idle: {}, ...messages });
export type Message = typeof Message.Type;
