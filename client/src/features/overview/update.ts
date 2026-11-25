import { AsyncData, Command } from "foldkit";
import { taggedStruct } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type { Filters } from "@dsiem/analytics-shared/filters";
import type { FeatureUpdate } from "../../lib/feature-update";
import { LoadOverview } from "./commands";
import { Message as M, type Message } from "./messages";
import { MetricTabs } from "./metric-tabs";
import type { Model } from "./model";

const SelectionInvalidated = taggedStruct("SelectionInvalidated");
export type Out = typeof SelectionInvalidated.Type;

export function reloadOverview(
  model: Model,
  filters: Filters,
): FeatureUpdate<Model, Message> {
  const generation = model.loadGeneration + 1;
  return {
    model: modifyFields(model, {
      loadGeneration: () => generation,
      overview: () => AsyncData.Loading(),
    }),
    commands: [LoadOverview({ generation, filters })],
  };
}

export function updateOverview(
  model: Model,
  message: Message,
): FeatureUpdate<Model, Message, Out> {
  return M.match<FeatureUpdate<Model, Message, Out>>(message, {
    GotMetricTabsMessage: ({ message }) => {
      const changed = MetricTabs.update(model.metricTabs, message);
      return {
        model: modifyFields(model, {
          metricTabs: () => changed.model,
          series: (series) => changed.outMessage?.value ?? series,
        }),
        commands: (changed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) =>
            M.GotMetricTabsMessage({ message }),
          ),
        ),
        ...(changed.outMessage ? { outMessage: SelectionInvalidated() } : {}),
      };
    },
    LoadedOverview: (message) =>
      message.generation !== model.loadGeneration
        ? { model }
        : {
            outMessage: SelectionInvalidated(),
            model: modifyFields(model, {
              overview: () => message.result,
            }),
          },
  });
}
