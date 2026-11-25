import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber, Queue, Result, Stream, SubscriptionRef } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AppApi } from "@dsiem/analytics-shared/api";
import { mapLoads } from "../src/features/gps/load";
import { dataKey, frameKey } from "../src/features/gps/model";
import type { MapData } from "../src/features/gps/mount";
import { ApiClient } from "../src/lib/api-client";
import { gpsFixture } from "./gps-fixture";

const mapData = ({
  query = "zip=10001",
  filters = { zip: "10001" },
  endpoint = "pickup",
  revision = 0,
  selected = null,
  loading = true,
}: Partial<MapData> = {}): MapData => ({
  query,
  filters,
  endpoint,
  revision,
  selected,
  loading,
  key: frameKey(query, endpoint, selected, revision),
});

type Load = Stream.Success<ReturnType<typeof mapLoads>>;
type PendingRequest = {
  readonly url: URL;
  readonly signal: AbortSignal | null | undefined;
  readonly respond: (response: Response) => void;
  readonly reject: (error: Error) => void;
};

const withMapLoads = <A, E>(
  run: (map: {
    inputs: SubscriptionRef.SubscriptionRef<MapData>;
    requests: Queue.Dequeue<PendingRequest>;
    results: Queue.Dequeue<Load>;
    stop: Effect.Effect<unknown>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const inputs = yield* SubscriptionRef.make(mapData());
      const requests = yield* Queue.unbounded<PendingRequest>();
      const results = yield* Queue.unbounded<Load>();
      const fetch: typeof globalThis.fetch = (url, init) =>
        new Promise((respond, reject) => {
          // Deliberately allow late settlement even after fetch is aborted.
          Queue.offerUnsafe(requests, {
            url: new URL(url instanceof Request ? url.url : url),
            signal: init?.signal,
            respond,
            reject,
          });
        });
      const fiber = yield* mapLoads(SubscriptionRef.changes(inputs)).pipe(
        Stream.runForEach((load) => Queue.offer(results, load)),
        Effect.provideServiceEffect(
          ApiClient,
          HttpApiClient.makeWith(AppApi, {
            httpClient: HttpClient.withScope(yield* HttpClient.HttpClient),
            baseUrl: "http://fixture.test",
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.forkChild,
      );
      return yield* run({
        inputs,
        requests,
        results,
        stop: Fiber.interrupt(fiber),
      });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.timeout("5 seconds")),
  );

test("GPS loads only on query changes and ignores late results after switching or unmounting", () =>
  withMapLoads(({ inputs, requests, results, stop }) =>
    Effect.gen(function* () {
      const initial = yield* Queue.take(requests);
      assert.equal(initial.url.searchParams.get("endpoint"), "pickup");
      yield* SubscriptionRef.set(inputs, mapData({ selected: "cell" }));

      const dropoff = mapData({ endpoint: "dropoff", revision: 1 });
      yield* SubscriptionRef.set(inputs, dropoff);
      const replacement = yield* Queue.take(requests);
      assert.equal(replacement.url.searchParams.get("endpoint"), "dropoff");
      assert.equal(initial.signal?.aborted, true);
      initial.respond(Response.json(gpsFixture()));

      replacement.respond(Response.json(gpsFixture("dropoff")));
      const { key, result } = yield* Queue.take(results);
      assert.equal(key, dataKey(dropoff.query, dropoff.endpoint, 1));
      assert.ok(Result.isSuccess(result));
      assert.equal(result.success.summary.loaded, 2);

      yield* SubscriptionRef.set(inputs, { ...dropoff, loading: false });
      yield* SubscriptionRef.set(inputs, { ...dropoff, revision: 2 });
      const pending = yield* Queue.take(requests);
      yield* stop;
      assert.equal(pending.signal?.aborted, true);
      pending.respond(Response.json(gpsFixture("dropoff")));
      assert.equal(yield* Queue.size(results), 0);
      assert.equal(yield* Queue.size(requests), 0);
    }),
  ));

test("GPS reports the active failure and keeps listening for a retry", () =>
  withMapLoads(({ inputs, requests, results }) =>
    Effect.gen(function* () {
      const initial = yield* Queue.take(requests);
      initial.respond(Response.json(gpsFixture()));
      assert.ok(Result.isSuccess((yield* Queue.take(results)).result));

      const next = mapData({
        query: "zip=10019",
        filters: { zip: "10019" },
        revision: 1,
      });
      yield* SubscriptionRef.set(inputs, next);
      const replacement = yield* Queue.take(requests);
      assert.equal(replacement.url.searchParams.get("zip"), "10019");
      replacement.respond(
        Response.json(
          { error: { code: "warehouse_unavailable", message: "Offline" } },
          { status: 503 },
        ),
      );
      const failed = yield* Queue.take(results);
      assert.equal(failed.key, dataKey(next.query, next.endpoint, 1));
      assert.ok(Result.isFailure(failed.result));
      assert.deepEqual(failed.result.failure, {
        error: { code: "warehouse_unavailable", message: "Offline" },
      });

      yield* SubscriptionRef.set(inputs, { ...next, revision: 2 });
      const retry = yield* Queue.take(requests);
      retry.respond(Response.json(gpsFixture()));
      const retried = yield* Queue.take(results);
      assert.equal(retried.key, dataKey(next.query, next.endpoint, 2));
      assert.ok(Result.isSuccess(retried.result));
    }),
  ));
