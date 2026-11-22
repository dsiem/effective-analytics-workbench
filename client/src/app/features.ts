import { Option } from "effect";
import { Update } from "foldkit";
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

export const filters = feature("filtersState", Message.Filters);
export const overview = feature("overviewState", Message.Overview);
export const trips = feature("tripsState", Message.Trips);
export const savedViews = feature("savedViewsState", Message.SavedViews);
export const genie = feature("genieState", Message.Genie);
export const gps = feature("gpsState", Message.Gps);
export const analysisRuns = feature("analysisRunsState", Message.AnalysisRuns);
