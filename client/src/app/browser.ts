import { frameEvents } from "@dsiem/workbench-ui/workspace-frame";
import { Subscription } from "foldkit";
import { subscriptions as analysisSubscriptions } from "../features/analysis-runs/subscription";
import { subscriptions as genieSubscriptions } from "../features/genie/subscription";
import {
  pendingOverview,
  subscriptions as overviewSubscriptions,
} from "../features/overview/subscription";
import { subscriptions as tripsSubscriptions } from "../features/trips/records";
import * as Features from "./features";
import type { Message } from "./message";
import type { Model } from "./model";

const appSubscriptions = Subscription.make<Model, Message>()((entry) => ({
  browser: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        frameEvents(
          Features.layout.toParentMessage,
          Features.theme.toParentMessage,
        ),
    },
  ),
}));

export const subscriptions = Subscription.aggregate(
  appSubscriptions,
  Subscription.lift(analysisSubscriptions)<Model, Message>({
    ...Features.analysisRuns,
    when: (model) => model.location.route._tag === "AnalysisRuns",
  }),
  Subscription.lift(genieSubscriptions)<Model, Message>(Features.genie),
  Subscription.lift(overviewSubscriptions)<Model, Message>({
    read: ({ overviewState, location }) =>
      pendingOverview(overviewState, location.filters),
    toParentMessage: Features.overview.toParentMessage,
    when: (model) => model.location.route._tag === "Overview",
  }),
  Subscription.lift(tripsSubscriptions)<Model, Message>({
    ...Features.trips,
    when: (model) => model.location.route._tag === "Trips",
  }),
);
