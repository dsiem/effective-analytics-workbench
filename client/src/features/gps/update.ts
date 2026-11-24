import { Command } from "foldkit";
import type { FeatureUpdate } from "../../lib/feature-update";
import { Message as M, type Message } from "./messages";
import { dataKey, frameKey, type Model } from "./model";
import { RefreshGps, type MapData } from "./mount";
import { EndpointTabs } from "./tabs";

type MapLocation = Pick<MapData, "query" | "filters">;
type Out = { readonly _tag: "SelectionInvalidated" };

const refresh = (model: Model, { query, filters }: MapLocation) => [
  RefreshGps({
    query,
    filters,
    endpoint: model.endpoint,
    revision: model.revision,
    key: frameKey(query, model.endpoint, model.selected, model.revision),
    loading: model.activity.loading,
    selected: model.selected,
  }),
];
export function reloadGps(
  model: Model,
  location: MapLocation,
): FeatureUpdate<Model, Message> {
  const next = {
    ...model,
    selected: null,
    selectedCell: null,
    revision: model.revision + 1,
    renderedKey: "",
    mapError: "",
    activity: { ...model.activity, loading: true, error: "" },
  };
  return {
    model: next,
    commands: refresh(next, location),
  };
}
export function updateGps(
  model: Model,
  message: Message,
  location: MapLocation,
): FeatureUpdate<Model, Message, Out> {
  switch (message._tag) {
    case "Idle":
      return { model };
    case "GpsTabs": {
      const changed = EndpointTabs.update(model.endpointTabs, message.message);
      const endpoint = changed.outMessage?.value ?? model.endpoint;
      const next =
        changed.model === model.endpointTabs && endpoint === model.endpoint
          ? model
          : { ...model, endpointTabs: changed.model, endpoint };
      const loaded: FeatureUpdate<Model, Message, Out> =
        endpoint === model.endpoint
          ? { model: next }
          : {
              ...reloadGps(next, location),
              outMessage: { _tag: "SelectionInvalidated" },
            };
      return {
        ...loaded,
        commands: [
          ...(changed.commands ?? []).map((command) =>
            Command.mapMessage(command, (message) => M.GpsTabs({ message })),
          ),
          ...(loaded.commands ?? []),
        ],
      };
    }
    case "LoadedGps": {
      if (
        message.key !== dataKey(location.query, model.endpoint, model.revision)
      )
        return { model };
      const next = {
        ...model,
        activity: { data: message.data, loading: false, error: message.error },
        renderedKey: "",
        mapError: "",
        selected: null,
        selectedCell: null,
      };
      return {
        model: next,
        commands: refresh(next, location),
        outMessage: { _tag: "SelectionInvalidated" },
      };
    }
    case "GpsReady":
      return message.key !==
        frameKey(location.query, model.endpoint, model.selected, model.revision)
        ? { model }
        : {
            model: {
              ...model,
              renderedKey: message.error ? "" : message.key,
              mapError: message.error,
              selectedCell:
                message.selectedCell === undefined
                  ? model.selectedCell
                  : message.selectedCell,
            },
          };
    case "GpsSelect": {
      if (model.activity.loading || model.selected === message.id)
        return { model };
      const next = {
        ...model,
        selected: message.id,
        selectedCell:
          model.activity.data?.cells.find((cell) => cell.id === message.id) ??
          null,
      };
      return {
        model: next,
        commands: refresh(next, location),
        outMessage: { _tag: "SelectionInvalidated" },
      };
    }
  }
}
