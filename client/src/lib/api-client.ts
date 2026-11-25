import { Context, type Duration, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AppApi } from "@dsiem/analytics-shared/api";

const makeClient = Effect.gen(function* () {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  return yield* HttpApiClient.makeWith(AppApi, { httpClient });
}).pipe(Effect.provide(FetchHttpClient.layer));

// One typed transport per runtime; each command scopes its response body.
export class ApiClient extends Context.Service<
  ApiClient,
  Effect.Success<typeof makeClient>
>()("taxi/ApiClient") {
  static readonly layer = Layer.effect(this, makeClient);
}
export const request = <A, E, R>(
  run: (client: ApiClient["Service"]) => Effect.Effect<A, E, R>,
  timeout: Duration.Input = "2 minutes",
) => Effect.flatMap(ApiClient, run).pipe(Effect.timeout(timeout));
