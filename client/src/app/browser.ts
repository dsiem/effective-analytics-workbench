import { Effect, Queue, Stream } from "effect";
import { Subscription } from "foldkit";
import { subscriptions as analysisSubscriptions } from "../features/analysis-runs/subscription";
import { subscriptions as genieSubscriptions } from "../features/genie/subscription";
import { subscriptions as tripsSubscriptions } from "../features/trips/subscription";
import * as Features from "./features";
import { Message as M, type Message } from "./message";
import type { Model } from "./model";
import { systemThemeQuery } from "./theme";

const appSubscriptions = Subscription.make<Model, Message>()((entry) => ({
  browser: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.callback<Message>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const keydown = (event: KeyboardEvent) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLowerCase() === "b"
                ) {
                  event.preventDefault();
                  Queue.offerUnsafe(queue, M.ToggleSidebar());
                }
              };
              const media = matchMedia("(max-width: 767px)");
              const resize = () =>
                Queue.offerUnsafe(queue, M.Resized({ mobile: media.matches }));
              const themeMedia = matchMedia(systemThemeQuery);
              const themeChanged = () =>
                Queue.offerUnsafe(queue, M.SystemThemeChanged());
              window.addEventListener("keydown", keydown);
              media.addEventListener("change", resize);
              themeMedia.addEventListener("change", themeChanged);
              return () => {
                window.removeEventListener("keydown", keydown);
                media.removeEventListener("change", resize);
                themeMedia.removeEventListener("change", themeChanged);
              };
            }),
            (cleanup) => Effect.sync(cleanup),
          ),
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
  Subscription.lift(tripsSubscriptions)<Model, Message>({
    ...Features.trips,
    when: (model) => model.location.route._tag === "Trips",
  }),
);
