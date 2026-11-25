import { Option } from "effect";
import { AsyncData, Command } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { FeatureUpdate } from "../../lib/feature-update";
import { Message as M, type Message } from "./messages";
import { dataKey, frameKey, type Model } from "./model";
import { RefreshGps, type MapData } from "./mount";
import { EndpointTabs } from "./tabs";

type MapLocation = Pick<MapData, "query" | "filters">;
type Out = { readonly _tag: "SelectionInvalidated" };

const refresh = (model: Model, { query, filters }: MapLocation) => {
  const selected = Option.getOrNull(model.selected);
  return [
    RefreshGps({
      query,
      filters,
      endpoint: model.endpoint,
      revision: model.revision,
      key: frameKey(query, model.endpoint, selected, model.revision),
      activityTag: model.activity._tag,
      selected,
    }),
  ];
};
export function reloadGps(
  model: Model,
  location: MapLocation,
): FeatureUpdate<Model, Message> {
  const next = modifyFields(model, {
    selected: Option.none,
    selectedCell: Option.none,
    revision: (revision) => revision + 1,
    renderedKey: () => "",
    mapError: () => "",
    activity: (activity) =>
      Option.getOrElse(AsyncData.revalidateOrLoad(activity), () => activity),
  });
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
  return M.match<FeatureUpdate<Model, Message, Out>>(message, {
    CompletedRefreshGps: () => ({ model }),
    GotGpsTabsMessage: (message) => {
      const changed = EndpointTabs.update(model.endpointTabs, message.message);
      const endpoint = changed.outMessage?.value ?? model.endpoint;
      const next =
        changed.model === model.endpointTabs && endpoint === model.endpoint
          ? model
          : modifyFields(model, {
              endpointTabs: () => changed.model,
              endpoint: () => endpoint,
            });
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
            Command.mapMessage(command, (message) =>
              M.GotGpsTabsMessage({ message }),
            ),
          ),
          ...(loaded.commands ?? []),
        ],
      };
    },
    LoadedGps: (message) => {
      if (
        message.key !== dataKey(location.query, model.endpoint, model.revision)
      )
        return { model };
      const next = modifyFields(model, {
        activity: () => message.result,
        renderedKey: () => "",
        mapError: () => "",
        selected: Option.none,
        selectedCell: Option.none,
      });
      return {
        model: next,
        commands: refresh(next, location),
        outMessage: { _tag: "SelectionInvalidated" },
      };
    },
    GpsReady: (message) =>
      message.key !==
      frameKey(
        location.query,
        model.endpoint,
        Option.getOrNull(model.selected),
        model.revision,
      )
        ? { model }
        : {
            model: modifyFields(model, {
              renderedKey: () => (message.error ? "" : message.key),
              mapError: () => message.error,
              selectedCell: (selectedCell) =>
                message.selectedCell === undefined
                  ? selectedCell
                  : Option.fromNullishOr(message.selectedCell),
            }),
          },
    GpsSelect: (message) => {
      if (
        AsyncData.isPending(model.activity) ||
        Option.getOrNull(model.selected) === message.id
      )
        return { model };
      const summary = Option.getOrUndefined(AsyncData.getData(model.activity));
      const next = modifyFields(model, {
        selected: () => Option.fromNullishOr(message.id),
        selectedCell: () =>
          Option.fromNullishOr(
            summary?.cells.find((cell) => cell.id === message.id),
          ),
      });
      return {
        model: next,
        commands: refresh(next, location),
        outMessage: { _tag: "SelectionInvalidated" },
      };
    },
  });
}
