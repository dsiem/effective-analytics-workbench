import { Effect, Stream } from "effect";
import { request } from "../../lib/api-client";
import { jsonMap } from "./dataset";
import { dataKey } from "./model";
import type { MapData } from "./mount";

type MapQuery = Pick<MapData, "query" | "filters" | "endpoint" | "revision">;

const loadGps = ({ filters, endpoint }: MapQuery) =>
  Effect.gen(function* () {
    const response = yield* request((client) =>
      client.analytics.tripMap({ query: { ...filters, endpoint } }),
    );
    if (response.endpoint !== endpoint)
      return yield* Effect.fail(new Error("Invalid map endpoint"));
    return yield* Effect.try(() => jsonMap(response));
  }).pipe(Effect.scoped);

export const mapLoads = <E, R>(inputs: Stream.Stream<MapQuery, E, R>) =>
  inputs.pipe(
    Stream.map((input) => ({
      key: dataKey(input.query, input.endpoint, input.revision),
      input,
    })),
    Stream.changesWith((previous, next) => previous.key === next.key),
    Stream.switchMap(({ key, input }) =>
      Stream.fromEffect(
        loadGps(input).pipe(
          Effect.result,
          Effect.map((result) => ({ key, result })),
        ),
      ),
    ),
  );
