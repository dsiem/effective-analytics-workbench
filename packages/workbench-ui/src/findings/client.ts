import { Effect, Schema, type Duration, type Scope } from "effect";
import type {
  SavedViewPin,
  SavedViewSearch,
  savedViewSchemas,
} from "@dsiem/analytics/contracts";

type Result<A> = Effect.Effect<A, unknown, Scope.Scope>;
type Saved<F> = ReturnType<typeof savedViewSchemas<Schema.Codec<F>>>;

export interface FindingOperations<F, E = string, R = never> {
  readonly list: (
    query: SavedViewSearch,
  ) => Effect.Effect<Saved<F>["SavedViewsPage"]["Type"], E, R>;
  readonly save: (
    draft: Saved<F>["SavedViewInput"]["Type"],
  ) => Effect.Effect<Saved<F>["SavedView"]["Type"], E, R>;
  readonly pin: (
    id: string,
    pinned: boolean,
    version: number,
  ) => Effect.Effect<unknown, E, R>;
  readonly remove: (
    id: string,
    version: number,
  ) => Effect.Effect<unknown, E, R>;
}

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

type FailurePolicy<E> = {
  readonly onError: (cause: unknown) => E;
  readonly timeout?: Duration.Input;
};

export function findingsClient<F, R = never>(
  client: Effect.Effect<FindingsClient<F>, unknown, R>,
): FindingOperations<F, string, R>;
export function findingsClient<F, E, R = never>(
  client: Effect.Effect<FindingsClient<F>, unknown, R>,
  options: FailurePolicy<E>,
): FindingOperations<F, E, R>;
export function findingsClient<F, E, R>(
  client: Effect.Effect<FindingsClient<F>, unknown, R>,
  options?: FailurePolicy<E>,
): FindingOperations<F, E | string, R> {
  const onError: (cause: unknown) => E | string =
    options?.onError ??
    ((problem) =>
      apiFailure(problem)
        ? problem.error.message
        : "The findings request failed. Please retry.");
  function request<A>(call: (api: FindingsClient<F>) => Result<A>) {
    return client.pipe(
      Effect.flatMap(call),
      Effect.scoped,
      Effect.timeout(options?.timeout ?? "30 seconds"),
      Effect.mapError(onError),
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
