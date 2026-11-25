import { Effect, Option, Schema, Stream } from "effect";
import { AsyncData, Subscription } from "foldkit";
import { Filters } from "@dsiem/analytics-shared/filters";
import { type ApiClient, request } from "../../lib/api-client";
import { result } from "../../lib/command-result";
import { Message as M, type Message } from "./messages";
import type { Model } from "./model";

const OverviewRequest = Schema.Struct({
  generation: Schema.Int,
  filters: Filters,
});
type OverviewRequest = typeof OverviewRequest.Type;

export const pendingOverview = (
  model: Model,
  filters: Option.Option<Filters>,
): Option.Option<OverviewRequest> =>
  AsyncData.isPending(model.overview)
    ? Option.map(filters, (filters) => ({
        generation: model.loadGeneration,
        filters,
      }))
    : Option.none();

export const subscriptions = Subscription.make<
  OverviewRequest,
  Message,
  ApiClient
>()((entry) => ({
  overview: entry(OverviewRequest.fields, {
    modelToDependencies: (request) => request,
    dependenciesToStream: ({ generation, filters }) =>
      Stream.fromEffect(
        result(
          request((client) => client.analytics.overview({ query: filters })),
        ).pipe(
          Effect.map((result) => M.LoadedOverview({ generation, result })),
        ),
      ),
  }),
}));
