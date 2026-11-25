import { Option } from "effect";
import { Command, Update } from "foldkit";
import { Message } from "./message";
import type { Model } from "./model";

function feature<Key extends keyof Model, ChildMessage>(
  key: Key,
  wrap: (payload: { message: ChildMessage }) => Message,
) {
  const write = (parent: Model, child: Model[Key]): Model =>
    parent[key] === child ? parent : { ...parent, [key]: child };
  const toParentMessage = (message: ChildMessage) => wrap({ message });
  return {
    read: (parent: Model) => Option.some(parent[key]),
    write,
    toParentMessage,
    mapCommand: <R>(command: Command.Command<ChildMessage, never, R>) =>
      Command.mapMessage(command, toParentMessage),
    foldInit: <R>(
      parent: Model,
      child: Update.Return<Model[Key], ChildMessage, R>,
    ) =>
      Update.foldChildInit(child, {
        toParentModel: (model) => write(parent, model),
        toParentMessage,
      }),
  };
}

export const filters = feature("filtersState", Message.GotFiltersMessage);
export const overview = feature("overviewState", Message.GotOverviewMessage);
export const trips = feature("tripsState", Message.GotTripsMessage);
export const savedViews = feature(
  "savedViewsState",
  Message.GotSavedViewsMessage,
);
export const genie = feature("genieState", Message.GotGenieMessage);
export const gps = feature("gpsState", Message.GotGpsMessage);
export const analysisRuns = feature(
  "analysisRunsState",
  Message.GotAnalysisRunsMessage,
);
export const layout = feature("layout", Message.GotLayoutMessage);
export const navigation = feature("location", Message.GotNavigationMessage);
export const theme = feature("theme", Message.GotThemeMessage);
