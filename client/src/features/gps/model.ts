import { Tabs } from "@foldkit/ui";
import { Schema } from "effect";
import {
  GpsEndpoint,
  MapCellSummary,
  MapSummary,
} from "../../../../shared/map-dataset";
import { empty, Notice, request } from "../../lib/request-state";
export const Model = Schema.Struct({
  endpoint: GpsEndpoint,
  endpointTabs: Tabs.Model,
  activity: request(MapSummary),
  revision: Schema.Int,
  selected: Schema.NullOr(Schema.String),
  selectedCell: Schema.NullOr(MapCellSummary),
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
  activity: empty,
  revision: 0,
  selected: null,
  selectedCell: null,
  renderedKey: "",
  mapError: "",
});
