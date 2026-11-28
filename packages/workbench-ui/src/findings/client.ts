import { Effect, Schema, type Scope } from "effect";
import type {
  SavedViewPin,
  SavedViewSearch,
  savedViewSchemas,
} from "@dsiem/analytics/contracts";

type Result<A> = Effect.Effect<A, unknown, Scope.Scope>;
type Saved<F> = ReturnType<typeof savedViewSchemas<Schema.Codec<F>>>;

interface FindingsClient<F> {
  readonly list: (request: {
    query: SavedViewSearch;
  }) => Result<Saved<F>["SavedViewsPage"]["Type"]>;
  readonly save: (request: {
    payload: Saved<F>["SavedViewInput"]["Type"];
  }) => Result<Saved<F>["SavedView"]["Type"]>;
  readonly pin: (request: {
    params: { id: string };
    payload: SavedViewPin;
  }) => Result<unknown>;
  readonly remove: (request: {
    params: { id: string };
    query: { version: number };
  }) => Result<unknown>;
}

const apiFailure = Schema.is(
  Schema.Struct({
    error: Schema.Struct({ message: Schema.String }),
  }),
);

/** Bind the generated savedViewsGroup client to the findings feature. */
export function findingsClient<F>(
  client: Effect.Effect<FindingsClient<F>, unknown>,
) {
  function request<A>(call: (api: FindingsClient<F>) => Result<A>) {
    return client.pipe(
      Effect.flatMap(call),
      Effect.scoped,
      Effect.timeout("30 seconds"),
      Effect.mapError((problem) =>
        apiFailure(problem)
          ? problem.error.message
          : "The findings request failed. Please retry.",
      ),
    );
  }
  return {
    list: (query: SavedViewSearch) => request((api) => api.list({ query })),
    save: (payload: Saved<F>["SavedViewInput"]["Type"]) =>
      request((api) => api.save({ payload })),
    pin: (id: string, pinned: boolean, version: number) =>
      request((api) =>
        api.pin({ params: { id }, payload: { pinned, version } }),
      ),
    remove: (id: string, version: number) =>
      request((api) => api.remove({ params: { id }, query: { version } })),
  };
}
