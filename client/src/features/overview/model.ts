import { Tabs } from "@foldkit/ui";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { Overview } from "@dsiem/analytics-shared/overview";
import { Notice } from "../../lib/request-state";
export const Model = Schema.Struct({
  metricTabs: Tabs.Model,
  overview: AsyncData.Schema(Overview, Notice).schema,
  loadGeneration: Schema.Int,
  series: Schema.Literals(["trips", "revenue"]),
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  metricTabs: Tabs.init({ id: "daily-metric" }),
  overview: AsyncData.Idle(),
  loadGeneration: 0,
  series: "trips",
});
