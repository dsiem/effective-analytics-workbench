import { Tabs } from "@foldkit/ui";
import { Schema } from "effect";
import { Overview } from "../../../../shared/overview";
import { empty, request } from "../../lib/request-state";
export const Model = Schema.Struct({
  metricTabs: Tabs.Model,
  overview: request(Overview),
  loadGeneration: Schema.Int,
  series: Schema.Literals(["trips", "revenue"]),
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  metricTabs: Tabs.init({ id: "daily-metric" }),
  overview: empty,
  loadGeneration: 0,
  series: "trips",
});
