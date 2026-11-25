import { Completion } from "../../lib/command-result";
import { Tabs } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Overview } from "@dsiem/analytics-shared/overview";

export const messages = {
  GotMetricTabsMessage: { message: Tabs.Message },
  LoadedOverview: {
    generation: Schema.Int,
    result: Completion(Overview),
  },
};

export const Message = defineMessageUnion(messages);
export type Message = typeof Message.Type;
