import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfigProvider,
  Effect,
  Layer,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ApiError, AppApi } from "../../shared/api.js";
import type { SavedView, SavedViewInput } from "../../shared/saved-views.js";
import { type Trip } from "../../shared/trips.js";
import { AnalysisRuns } from "../src/analysis-runs.js";
import { Analytics } from "../src/taxi/analytics.js";
import { TripNotFound } from "../src/errors.js";
import { Genie } from "../src/genie/service.js";
import { Routes } from "../src/routes.js";
import { SavedViews } from "../src/saved-views.js";
import { Settings } from "../src/settings.js";
import { TripComments } from "../src/trip-comments.js";
import { Workspace } from "../src/workspace.js";

const operation = { conversationId: "conversation-1", messageId: "message-1" };
const savedView: SavedViewInput = {
  id: "472a6613-2337-4af1-a416-e9b6b61064dd",
  title: "Finding",
  body: "Fare analysis",
  filters: { from: "2016-01-01", zip: "10001" },
  version: null,
};
const metadata = { from: "2016-01-01", to: "2016-12-31", trips: 10 };
const filters = { from: "2016-01-01", to: "2016-02-01", zip: "10001" };
const sort = "fare";
const tripSummary = {
  trip_id: "trip-1",
  pickup_at: "2016-01-20 10:00:00.123456",
  dropoff_at: "2016-01-20 10:10:00.987654",
  pickup_zip: "10001",
  dropoff_zip: "Unknown",
  fare: 10,
  distance: 2,
  duration: 10,
};
const trip: Trip = {
  ...tripSummary,
  details: {
    source_file: "test.csv",
    vendor_id: null,
    passenger_count: null,
    rate_code_id: null,
    store_and_fwd_flag: null,
    payment_type: null,
    pickup_location: null,
    dropoff_location: null,
    tip_amount: 0,
    tolls_amount: null,
    extra: null,
    mta_tax: null,
    improvement_surcharge: null,
    total_amount: null,
  },
};
const overview = {
  summary: {
    trips: 10,
    revenue: 100,
    avg_fare: 10,
    avg_distance: 2,
    avg_duration: 5,
  },
  daily: [],
  hourly: [],
  zones: [],
  queriedAt: "2026-11-13T00:00:00Z",
};

const pageCursor = "00000000-0000-4000-8000-000000000000.1";
const firstTripPage = {
  rows: [tripSummary],
  nextCursor: pageCursor,
  hasMoreMatches: true,
};
const nextTripPage = {
  rows: [{ ...tripSummary, trip_id: "trip-2" }],
  nextCursor: null,
  hasMoreMatches: true,
};
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

const fixture = () => {
  const calls: Array<readonly [string, unknown]> = [];
  let savedViews: SavedView[] = [];
  const record = <A>(name: string, input: unknown, output: A) =>
    Effect.sync(() => {
      calls.push([name, input]);
      return output;
    });
  const unexpectedRun = Effect.die("Unexpected analysis operation");
  const app = HttpRouter.toWebHandler(
    Routes.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Workspace, {
            requestEvents: () =>
              Effect.die("Unexpected workspace event request"),
            accessToken: Effect.succeed(Redacted.make("unused")),
            request: () => Effect.die("Unexpected workspace request"),
          }),
          Layer.succeed(AnalysisRuns, {
            list: unexpectedRun,
            get: () => unexpectedRun,
            submit: () => unexpectedRun,
            result: () => unexpectedRun,
          }),
          Layer.succeed(Analytics, {
            metadata: Effect.succeed(metadata),
            overview: (input) => record("overview", input, overview),
            tripMap: (input) =>
              record("gps", input, {
                endpoint: input.endpoint ?? "pickup",
                matchingTrips: 10,
                locatedTrips: 0,
                shownTrips: 0,
                totalCells: 0,
                truncated: false,
                cells: [],
                queriedAt: "2016-02-01T00:00:00Z",
              }),
            trips: (input) => record("trips", input, bytes(firstTripPage)),
            tripPage: (cursor) =>
              record("tripPage", cursor, bytes(nextTripPage)),
            tripDetails: (tripId) =>
              tripId === trip.trip_id
                ? record("tripDetails", tripId, trip)
                : Effect.fail(new TripNotFound({ message: "Trip not found" })),
          }),
          Layer.succeed(Genie, {
            forViewer: () =>
              Effect.succeed({
                downloadCsv: (reference) =>
                  record(
                    "downloadCsv",
                    reference,
                    Stream.make(new TextEncoder().encode("count\r\n10\r\n")),
                  ),
                submit: (input) => record("submit", input, operation),
                poll: (input) =>
                  record("poll", input, {
                    ...operation,
                    state: "completed" as const,
                    status: "COMPLETED",
                  }),
                cancel: ({ conversationId, responseId }) =>
                  record(
                    "cancelGenieAgent",
                    { conversationId, responseId },
                    {
                      conversationId,
                      messageId: responseId,
                      mode: "agent" as const,
                      state: "cancelled" as const,
                      status: "CANCELLED",
                    },
                  ),
                result: (input) =>
                  record("result", input, {
                    ...operation,
                    text: "Ten trips",
                    queries: [],
                  }),
              }),
          }),
          Layer.succeed(TripComments, {
            counts: (search) => record("tripCommentCounts", search, {}),
            list: (search) =>
              record("tripComments", search, { rows: [], nextCursor: null }),
            add: (input, author) =>
              record(
                "addTripComment",
                { input, author },
                { ...input, author, created_at: "2026-11-14T10:00:00Z" },
              ),
          }),
          Layer.succeed(SavedViews, {
            list: (search) =>
              Effect.sync(() => {
                if (
                  search.cursor ||
                  search.q !== undefined ||
                  search.ids !== undefined
                )
                  calls.push(["savedViews", search]);
                return { rows: savedViews, nextCursor: null };
              }),
            save: (input) =>
              Effect.sync(() => {
                calls.push(["save", input]);
                const saved = {
                  ...input,
                  version: (input.version ?? 0) + 1,
                  pinned: false,
                  created_at: "2026-11-13",
                  updated_at: "2026-11-13",
                };
                savedViews = [saved];
                return saved;
              }),
            pin: (id, input) =>
              record(
                "pin",
                { id, ...input },
                {
                  ...savedView,
                  version: input.version + 1,
                  pinned: input.pinned,
                  created_at: "2026-11-13",
                  updated_at: "2026-11-13",
                },
              ),
            remove: (id) =>
              Effect.sync(() => {
                calls.push(["remove", id]);
                savedViews = savedViews.filter((entry) => entry.id !== id);
              }),
          }),
          Settings.layer.pipe(
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnvRecord({}),
              ),
            ),
          ),
        ),
      ),
      Layer.provideMerge(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  const fetch: typeof globalThis.fetch = (input, init) =>
    app.handler(new Request(input, init));
  const client = Effect.runSync(
    HttpApiClient.make(AppApi, { baseUrl: "http://localhost" }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  return { app, client, calls };
};

test("generated client round-trips typed JSON endpoints through the real HTTP contract", async (t) => {
  const { app, client, calls } = fixture();
  t.after(app.dispose);
  await Effect.runPromise(
    Effect.gen(function* () {
      assert.equal(yield* client.viewer.current(), null);
      assert.deepEqual(yield* client.analytics.metadata(), metadata);
      assert.deepEqual(
        yield* client.analytics.overview({ query: filters }),
        overview,
      );
      assert.equal(
        (yield* client.analytics.tripMap({
          query: { ...filters, endpoint: "dropoff" },
        })).matchingTrips,
        10,
      );
      assert.deepEqual(
        yield* client.tripComments.counts({
          query: { tripIds: ["trip-1", "trip-2"] },
        }),
        {},
      );
      assert.deepEqual(
        yield* client.analytics.tripDetails({
          query: { tripId: trip.trip_id },
        }),
        trip,
      );
      const page = yield* client.analytics.trips({
        query: { ...filters, sort, limit: 2 },
      });
      assert.deepEqual(page, firstTripPage);
      assert.ok(page.nextCursor);
      assert.deepEqual(
        yield* client.analytics.tripPage({
          params: { cursor: page.nextCursor },
        }),
        nextTripPage,
      );
      assert.deepEqual(
        yield* client.genie.submit({
          headers: {},
          payload: { content: "Count trips", conversationId: "previous-1" },
        }),
        operation,
      );
      assert.deepEqual(
        yield* client.genie.poll({ headers: {}, params: operation, query: {} }),
        {
          ...operation,
          state: "completed",
          status: "COMPLETED",
        },
      );
      const cancelTarget = {
        conversationId: operation.conversationId,
        responseId: operation.messageId,
      };
      assert.deepEqual(
        yield* client.genie.cancel({ headers: {}, params: cancelTarget }),
        {
          ...operation,
          mode: "agent",
          state: "cancelled",
          status: "CANCELLED",
        },
      );
      assert.deepEqual(
        yield* client.genie.result({
          headers: {},
          params: operation,
          query: {},
        }),
        {
          ...operation,
          text: "Ten trips",
          queries: [],
        },
      );
      const saved = yield* client.savedViews.save({ payload: savedView });
      assert.deepEqual(saved, {
        ...savedView,
        version: 1,
        pinned: false,
        created_at: "2026-11-13",
        updated_at: "2026-11-13",
      });
      assert.deepEqual(yield* client.savedViews.list({ query: {} }), {
        rows: [saved],
        nextCursor: null,
      });
      const pinned = yield* client.savedViews.pin({
        params: { id: savedView.id },
        payload: { version: saved.version, pinned: true },
      });
      assert.equal(pinned.pinned, true);
      assert.equal(pinned.version, 2);
      assert.deepEqual(
        yield* client.savedViews.remove({
          params: { id: savedView.id },
          query: { version: pinned.version },
        }),
        {
          deleted: true,
        },
      );
      assert.deepEqual(yield* client.savedViews.list({ query: {} }), {
        rows: [],
        nextCursor: null,
      });
    }),
  );
  assert.deepEqual(calls, [
    ["overview", filters],
    ["gps", { ...filters, endpoint: "dropoff" }],
    ["tripCommentCounts", { tripIds: ["trip-1", "trip-2"] }],
    ["tripDetails", trip.trip_id],
    ["trips", { ...filters, sort, limit: 2 }],
    ["tripPage", pageCursor],
    ["submit", { content: "Count trips", conversationId: "previous-1" }],
    ["poll", operation],
    [
      "cancelGenieAgent",
      {
        conversationId: operation.conversationId,
        responseId: operation.messageId,
      },
    ],
    ["result", operation],
    ["save", savedView],
    ["pin", { id: savedView.id, version: 1, pinned: true }],
    ["remove", savedView.id],
  ]);
});

test("generated CSV endpoint decodes attachment headers and streams bytes", async (t) => {
  const { app, client, calls } = fixture();
  t.after(app.dispose);
  const params = { ...operation, attachmentId: "query" };
  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* client.genie.downloadCsv({
        params,
        payload: undefined,
      });
      assert.equal(
        result.headers["content-disposition"],
        'attachment; filename="genie-results.csv"',
      );
      assert.equal(result.headers["x-content-type-options"], "nosniff");
      const chunks = yield* Stream.runCollect(result.body);
      assert.equal(Buffer.concat(chunks).toString(), "count\r\n10\r\n");
    }).pipe(Effect.scoped),
  );
  assert.deepEqual(calls, [["downloadCsv", params]]);
});

test("missing trip details return a typed 404", async (t) => {
  const { app, client } = fixture();
  t.after(app.dispose);
  const response = await app.handler(
    new Request("http://local.test/api/trip-details?tripId=missing"),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(
    await Effect.runPromise(
      Effect.flip(
        client.analytics.tripDetails({ query: { tripId: "missing" } }),
      ),
    ),
    { error: { code: "trip_not_found", message: "Trip not found" } },
  );
});

test("the previous trip stream URL is no longer registered", async (t) => {
  const { app } = fixture();
  t.after(app.dispose);
  const response = await app.handler(
    new Request("http://local.test/api/trip-preview"),
  );
  assert.equal(response.status, 404);
});

test("invalid query, path and JSON inputs never reach services", async (t) => {
  const { app, calls } = fixture();
  t.after(app.dispose);
  for (const [path, init] of [
    ["/api/overview?zip=invalid", undefined],
    ["/api/overview?from=2016-02-01&to=2016-01-01", undefined],
    ["/api/trips?from=2016-02-01&to=2016-01-01", undefined],
    ["/api/trip-map?from=2016-02-01&to=2016-01-01", undefined],
    ["/api/trip-map?endpoint=coordinates", undefined],
    [
      "/api/saved-views",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...savedView,
          filters: { from: "2016-02-01", to: "2016-01-01" },
        }),
      },
    ],
    ...[
      { from: "2016-02-01", to: "2016-01-01" },
      { zip: "bad" },
      { to: "2016-02-30" },
    ].map(
      (filters) =>
        [
          "/api/genie",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Count", filters }),
          },
        ] as const,
    ),
    ["/api/overview?from=2016-02-31", undefined],
    ["/api/trips?page=0", undefined],
    ["/api/trips?page=2", undefined],
    ["/api/trips?cursor=not-json", undefined],
    ["/api/trips?stream=1", undefined],
    ["/api/trips?sort=unsafe", undefined],
    ["/api/trips?limit=0", undefined],
    ["/api/trips?limit=-1", undefined],
    ["/api/trips?limit=1.5", undefined],
    ["/api/trips?limit=lots", undefined],
    ["/api/trips?limit=2147483647", undefined],
    ["/api/trip-details?tripId=", undefined],
    ["/api/trip-details", undefined],
    ["/api/trip-comment-counts?tripIds=not-json", undefined],
    ...[[], [""], Array(26).fill("trip-1")].map(
      (tripIds) =>
        [
          `/api/trip-comment-counts?tripIds=${encodeURIComponent(JSON.stringify(tripIds))}`,
          undefined,
        ] as const,
    ),
    ["/api/saved-views?cursor=not-json", undefined],
    [
      `/api/saved-views?${new URLSearchParams({ q: "x".repeat(201) }).toString()}`,
      undefined,
    ],
    ["/api/saved-views?ids=not-json", undefined],
    ...[
      null,
      {},
      savedView.id,
      [null],
      [1],
      ["bad-id"],
      ["472a6613-2337-1af1-a416-e9b6b61064dd"],
      Array(6).fill(savedView.id),
    ].map(
      (ids) =>
        [
          `/api/saved-views?${new URLSearchParams({ ids: JSON.stringify(ids) }).toString()}`,
          undefined,
        ] as const,
    ),
    ...[
      {},
      {
        id: savedView.id,
        pinned: "true",
        updatedAt: "2026-11-13T00:00:00.000000Z",
      },
      { id: "bad-id", pinned: false, updatedAt: "2026-11-13T00:00:00.000000Z" },
      {
        id: savedView.id,
        pinned: false,
        updatedAt: "2026-02-30T00:00:00.000000Z",
      },
      { id: savedView.id, pinned: false, updatedAt: "2026-11-13T00:00:00Z" },
    ].map(
      (cursor) =>
        [
          `/api/saved-views?${new URLSearchParams({ cursor: JSON.stringify(cursor) }).toString()}`,
          undefined,
        ] as const,
    ),
    ["/api/genie/bad%20id/messages/message", undefined],
    ["/api/saved-views/bad-id", { method: "DELETE" }],
    [`/api/saved-views/${savedView.id}`, { method: "DELETE" }],
    [`/api/saved-views/${savedView.id}?version=0`, { method: "DELETE" }],
    [
      `/api/saved-views/${savedView.id}/pin`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    ],
    [
      "/api/genie",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      },
    ],
    [
      "/api/genie",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"content":""}',
      },
    ],
    [
      "/api/saved-views",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...savedView, version: 0 }),
      },
    ],
  ] as const) {
    const response = await app.handler(
      new Request(`http://localhost${path}`, init),
    );
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: {
        code: "invalid_request",
        message: "Check the request fields, dates, and ZIP code.",
      },
    });
  }
  assert.deepEqual(calls, []);
});

test("generated client round-trips a microsecond saved-view cursor through the HTTP boundary", async (t) => {
  const { app, client, calls } = fixture();
  t.after(app.dispose);
  const cursor = {
    id: savedView.id,
    pinned: true,
    updatedAt: "2026-11-13T10:00:00.000123Z",
  };
  assert.deepEqual(
    await Effect.runPromise(client.savedViews.list({ query: { cursor } })),
    {
      rows: [],
      nextCursor: null,
    },
  );
  assert.deepEqual(calls, [["savedViews", { cursor }]]);
});

test("saved-view query round-trips bounded global search and recent IDs through the HTTP boundary", async (t) => {
  const { app, client, calls } = fixture();
  t.after(app.dispose);
  const cursor = {
    id: savedView.id,
    pinned: false,
    updatedAt: "2026-11-13T10:00:00.000123Z",
  };
  const ids = Array.from(
    { length: 5 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const queries = [
    { q: "" },
    { q: " \t\n " },
    { q: "Airport % _ ' \\ 10001" },
    { q: "x".repeat(200), ids, cursor },
    { ids: [] },
  ];
  for (const query of queries) {
    assert.deepEqual(
      await Effect.runPromise(client.savedViews.list({ query })),
      {
        rows: [],
        nextCursor: null,
      },
    );
  }
  assert.deepEqual(
    calls,
    queries.map((query) => ["savedViews", query]),
  );
});

test("generated saved-view client rejects search or IDs outside their bounds before sending", async (t) => {
  const { app, client, calls } = fixture();
  t.after(app.dispose);
  for (const query of [
    { q: "x".repeat(201) },
    { ids: Array(6).fill(savedView.id) },
    { ids: ["bad-id"] },
  ]) {
    const result = await Effect.runPromise(
      Effect.result(client.savedViews.list({ query })),
    );
    assert.ok(
      result._tag === "Failure" && Schema.isSchemaError(result.failure),
    );
  }
  assert.deepEqual(calls, []);
});

test("generated client rejects reversed dates before sending a request", async (t) => {
  const { app, client, calls } = fixture();
  t.after(app.dispose);
  const result = await Effect.runPromise(
    Effect.result(
      client.analytics.overview({
        query: { from: "2016-02-01", to: "2016-01-01" },
      }),
    ),
  );
  assert.ok(result._tag === "Failure" && Schema.isSchemaError(result.failure));
  assert.deepEqual(calls, []);
});

test("generated client preserves validation codes and messages at the UI boundary", async (t) => {
  const { app } = fixture();
  t.after(app.dispose);
  const response = await app.handler(
    new Request("http://localhost/api/overview?from=2016-02-01&to=2016-01-01"),
  );
  assert.equal(response.status, 400);
  const client = Effect.runSync(
    HttpApiClient.make(AppApi, { baseUrl: "http://localhost" }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, async () =>
        response.clone(),
      ),
    ),
  );
  const request = client.analytics.overview({ query: {} });
  const result = await Effect.runPromise(Effect.result(request));
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure")
    assert.deepEqual(result.failure, {
      error: {
        code: "invalid_request",
        message: "Check the request fields, dates, and ZIP code.",
      },
    });
});

for (const { status, error } of [
  {
    status: 409,
    error: {
      code: "saved_view_conflict",
      message: "Reload the latest saved view",
    },
  },
  {
    status: 403,
    error: {
      code: "permission_denied",
      message: "Even Genie needs permission to send this question.",
    },
  },
  {
    status: 502,
    error: {
      code: "workspace_request_failed",
      message: "Databricks rejected the request",
      upstreamStatus: 429,
    },
  },
  {
    status: 504,
    error: { code: "genie_timeout", message: "Submission timed out" },
  },
] as const) {
  test(`UI callers can distinguish ${error.code} without parsing its message`, async () => {
    const client = Effect.runSync(
      HttpApiClient.make(AppApi, { baseUrl: "http://localhost" }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, async () =>
          Response.json({ error }, { status }),
        ),
      ),
    );
    const failure =
      error.code === "saved_view_conflict"
        ? await Effect.runPromise(
            Effect.flip(client.savedViews.save({ payload: savedView })),
          )
        : await Effect.runPromise(
            Effect.flip(
              client.genie.submit({
                headers: {},
                payload: { content: "Count trips" },
              }),
            ),
          );
    assert.ok(Schema.is(ApiError)(failure));
    assert.equal(failure.error.code, error.code);
    assert.equal(failure.error.message, error.message);
    assert.equal(
      "upstreamStatus" in failure.error
        ? failure.error.upstreamStatus
        : undefined,
      "upstreamStatus" in error ? error.upstreamStatus : undefined,
    );
  });
}

test("generated client rejects an unexpected success response", async () => {
  const client = Effect.runSync(
    HttpApiClient.make(AppApi, { baseUrl: "http://localhost" }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, async () =>
        Response.json({ trips: "wrong" }),
      ),
    ),
  );
  const result = await Effect.runPromise(
    Effect.result(client.analytics.metadata()),
  );
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure")
    assert.ok(Schema.isSchemaError(result.failure));
});

test(
  "UI cancellation aborts a generated-client response body after headers arrive",
  {
    timeout: 5000,
  },
  async () => {
    let signal: AbortSignal | null | undefined;
    let bodyStarted!: () => void;
    const reading = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(new Error("aborted")),
              { once: true },
            );
            bodyStarted();
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    const client = Effect.runSync(
      Effect.gen(function* () {
        return yield* HttpApiClient.makeWith(AppApi, {
          baseUrl: "http://localhost",
          httpClient: HttpClient.withScope(yield* HttpClient.HttpClient),
        });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );
    const controller = new AbortController();
    const pending = Effect.runPromise(
      client.analytics.metadata().pipe(Effect.scoped),
      {
        signal: controller.signal,
      },
    );
    const rejected = assert.rejects(pending);
    await reading;
    controller.abort();
    await rejected;
    assert.equal(signal?.aborted, true);
  },
);

test("trip comment contract round-trips snapshots and attributes the request viewer", async (t) => {
  const { app, client, calls } = fixture();
  t.after(app.dispose);
  const trip = {
    trip_id: "7b2c6ab2-6f7d-4f8a-a05f-d07e4eb84a19",
    pickup_at: "2016-01-20 09:42:00",
    dropoff_at: "2016-01-20 09:56:00",
    pickup_zip: "10001",
    dropoff_zip: "10019",
    distance: 3.2,
    fare: 18.5,
    duration: 14,
  };
  const cursor = { id: savedView.id, createdAt: "2026-11-14T10:00:00.123456Z" };
  assert.deepEqual(
    await Effect.runPromise(
      client.tripComments.list({ query: { tripId: trip.trip_id, cursor } }),
    ),
    { rows: [], nextCursor: null },
  );
  assert.deepEqual(calls.at(-1), [
    "tripComments",
    { tripId: trip.trip_id, cursor },
  ]);
  const legacy = new URLSearchParams({
    trip: JSON.stringify(trip),
    cursor: JSON.stringify(cursor),
  });
  const oldClient = await app.handler(
    new Request(`http://localhost/api/trip-comments?${legacy.toString()}`),
  );
  assert.equal(oldClient.status, 400);
  assert.equal(calls.filter(([name]) => name === "tripComments").length, 1);
  const input = { id: savedView.id, trip, body: "Check the fare" };
  const response = await app.handler(
    new Request("http://localhost/api/trip-comments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Preferred-Username": "Avery Morgan",
        "X-Forwarded-Email": "avery@example.test",
      },
      body: JSON.stringify({
        ...input,
        author: { name: "Spoofed author", email: null },
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const author = { name: "Avery Morgan", email: "avery@example.test" };
  assert.deepEqual(await response.json(), {
    ...input,
    author,
    created_at: "2026-11-14T10:00:00Z",
  });
  assert.deepEqual(calls.at(-1), ["addTripComment", { input, author }]);
  const count = calls.length;
  for (const body of ["", " \t\n", "x".repeat(4001)]) {
    const invalid = await app.handler(
      new Request("http://localhost/api/trip-comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, body }),
      }),
    );
    assert.equal(invalid.status, 400);
  }
  assert.equal(calls.length, count);
});
