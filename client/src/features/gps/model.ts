import { Tabs } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import {
  GpsEndpoint,
  MapCellSummary,
  MapSummary,
} from "@dsiem/analytics-shared/map-dataset";
import { Notice } from "../../lib/request-state";
export const Model = Schema.Struct({
  endpoint: GpsEndpoint,
  endpointTabs: Tabs.Model,
  activity: AsyncData.Schema(MapSummary, Notice).schema,
  revision: Schema.Int,
  selected: Schema.Option(Schema.String),
  selectedCell: Schema.Option(MapCellSummary),
  renderedKey: Schema.String,
  mapError: Notice,
});
export type Model = typeof Model.Type;
export const endpointName = (endpoint: GpsEndpoint) =>
  endpoint === "pickup" ? "pickups" : "drop-offs";
export const dataKey = (query: string, endpoint: GpsEndpoint, revision = 0) =>
  JSON.stringify([query, endpoint, revision]);
export const frameKey = (
  query: string,
  endpoint: GpsEndpoint,
  selected: string | null,
  revision = 0,
) => JSON.stringify([query, endpoint, selected, revision]);
export const init = (): Model => ({
  endpoint: "pickup",
  endpointTabs: Tabs.init({ id: "gps-endpoint" }),
  activity: AsyncData.Idle(),
  revision: 0,
  selected: Option.none(),
  selectedCell: Option.none(),
  renderedKey: "",
  mapError: "",
});
