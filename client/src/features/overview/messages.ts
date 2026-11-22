import { Notice } from "../../lib/request-state";
import { Tabs } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Overview } from "../../../../shared/overview";

export const messages = {
  MetricTabs: { message: Tabs.Message },
  LoadedOverview: {
    generation: Schema.Int,
    data: Schema.NullOr(Overview),
    error: Notice,
  },
};

export const Message = defineMessageUnion({ Idle: {}, ...messages });
export type Message = typeof Message.Type;
