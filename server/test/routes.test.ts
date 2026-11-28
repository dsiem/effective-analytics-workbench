import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  ConfigProvider,
  Effect,
  Layer,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { OpenApi } from "effect/http-api";
import { ApiError, AppApi } from "@dsiem/analytics-shared/api";
import { GenieOperation } from "@dsiem/analytics-shared/genie";
import { AnalysisRuns } from "../src/analysis-runs.js";
import { Analytics } from "../src/taxi/analytics.js";
import {
  GenieAgentModeUnavailable,
  GenieFailed,
  InvalidRequest,
  OperationTimeout,
  PermissionDenied,
  SavedViewConflict,
  SavedViewNotFound,
  unavailable,
  UpstreamError,
} from "../src/errors.js";
import { Genie, type GenieViewer } from "../src/genie/service.js";
import { Routes } from "../src/routes.js";
import { SavedViews } from "../src/saved-views.js";
import { Settings } from "../src/settings.js";
import { TripComments } from "../src/trip-comments.js";
import { Workspace } from "../src/workspace.js";

type Services = {
  genie?: Partial<GenieViewer> | "live";
  workspace?: Partial<typeof Workspace.Service>;
  analytics?: Partial<typeof Analytics.Service>;
  tripComments?: Partial<typeof TripComments.Service>;
  savedViews?: Partial<typeof SavedViews.Service>;
};
const appFor = (
  overrides: Services = {},
  env: Readonly<Record<string, string>> = {},
) => {
  const unexpected = Effect.die("Unexpected service call");
  return HttpRouter.toWebHandler(
    Routes.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AnalysisRuns, {}),
          Layer.mock(Analytics, overrides.analytics ?? {}),
          overrides.genie === "live"
            ? Genie.layer
            : Layer.succeed(Genie, {
                forViewer: () =>
                  Effect.succeed({
                    submit: () => unexpected,
                    poll: () => unexpected,
                    result: () => unexpected,
                    cancel: () => unexpected,
                    downloadCsv: () => unexpected,
                    ...(typeof overrides.genie === "object"
                      ? overrides.genie
                      : {}),
                  }),
              }),
          Layer.mock(TripComments, overrides.tripComments ?? {}),
          Layer.mock(SavedViews, overrides.savedViews ?? {}),
        ).pipe(
          Layer.provideMerge(
            Layer.mock(Workspace, {
              accessToken: Effect.succeed(Redacted.make("unused")),
              ...overrides.workspace,
            }),
          ),
          Layer.provideMerge(
            Settings.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnvRecord(env),
                ),
              ),
            ),
          ),
        ),
      ),
      Layer.provideMerge(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
};

test("trip page responses negotiate gzip and return typed rows with a cursor", async (t) => {
  const cursor = "00000000-0000-4000-8000-000000000000.1";
  const rows = Array.from({ length: 12 }, (_, index) => ({
    trip_id: `trip-${index}`,
    pickup_at: "2016-01-20 10:00:00",
    dropoff_at: "2016-01-20 10:10:00",
    pickup_zip: "10001",
    dropoff_zip: "Unknown",
    fare: 10,
    distance: 2,
    duration: 10,
  }));
  const first = { rows, nextCursor: cursor, hasMoreMatches: true };
  const last = { rows, nextCursor: null, hasMoreMatches: true };
  const encode = (page: typeof first | typeof last) =>
    new TextEncoder().encode(JSON.stringify(page));
  const app = appFor({
    analytics: {
      trips: () => Effect.succeed(encode(first)),
      tripPage: (requested) =>
        requested === cursor
          ? Effect.succeed(encode(last))
          : Effect.fail(new InvalidRequest({ message: "Invalid trip page" })),
    },
  });
  t.after(app.dispose);
  for (const [path, page] of [
    ["/api/trips", first],
    [`/api/trips/pages/${cursor}`, last],
  ] as const) {
    for (const accept of ["gzip", "gzip;q=0"]) {
      const response = await app.handler(
        new Request(`http://localhost${path}`, {
          headers: { "accept-encoding": accept },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("link"), null);
      assert.match(
        response.headers.get("content-type") ?? "",
        /^application\/json/,
      );
      assert.match(response.headers.get("vary") ?? "", /accept-encoding/i);
      assert.equal(
        response.headers.get("content-encoding"),
        accept === "gzip" ? "gzip" : null,
      );
      const wire = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(
        JSON.parse(
          new TextDecoder().decode(accept === "gzip" ? gunzipSync(wire) : wire),
        ),
        page,
      );
    }
  }
  const invalid = await app.handler(
    new Request(
      "http://localhost/api/trips/pages/00000000-0000-4000-8000-000000000000.2",
    ),
  );
  assert.equal(invalid.status, 400);
  assert.equal(
    (await Schema.decodeUnknownPromise(ApiError)(await invalid.json())).error
      .code,
    "invalid_request",
  );
});

const removeView = new Request(
  "http://localhost/api/saved-views/00000000-0000-4000-8000-000000000001?version=1",
  { method: "DELETE" },
);
const getGenieResult = new Request(
  "http://localhost/api/genie/conversation/messages/message/result",
);
const conflict = new SavedViewConflict({
  id: "id",
  message: "Reload the latest saved view",
});
const missing = new SavedViewNotFound({ id: "id", message: "Already removed" });
const outage = unavailable(
  "lakebase",
  "Lakebase unavailable",
  new Error("private diagnostic"),
);
const denied = new PermissionDenied({
  message:
    "This conversation is under lock. You need permission to read Genie’s answer.",
});
const genieTimeout = new OperationTimeout({
  service: "genie",
  message: "Resume this answer",
});
const warehouseTimeout = new OperationTimeout({
  service: "warehouse",
  message: "Admission deadline expired",
});
const genieFailed = new GenieFailed({
  status: "FAILED",
  message: "Question failed",
});

const csvTimeout = new OperationTimeout({
  service: "genie_csv",
  message: "Transfer capacity timed out",
});
const agentDisabled = new GenieAgentModeUnavailable({
  message: "Agent mode is disabled",
});
const upstreamNotModified = new UpstreamError({
  service: "workspace",
  upstreamStatus: 304,
  message: "Unexpected upstream status",
});

for (const { request, services, status, error } of [
  {
    request: removeView,
    services: { savedViews: { remove: () => Effect.fail(conflict) } },
    status: 409,
    error: { code: "saved_view_conflict", message: conflict.message },
  },
  {
    request: removeView,
    services: { savedViews: { remove: () => Effect.fail(missing) } },
    status: 404,
    error: { code: "saved_view_not_found", message: missing.message },
  },
  {
    request: new Request("http://localhost/api/saved-views"),
    services: { savedViews: { list: () => Effect.fail(outage) } },
    status: 503,
    error: { code: "lakebase_unavailable", message: outage.message },
  },
  {
    request: new Request("http://localhost/api/trip-comments?tripId=trip-1"),
    services: { tripComments: { list: () => Effect.fail(outage) } },
    status: 503,
    error: { code: "lakebase_unavailable", message: outage.message },
  },
  {
    request: getGenieResult,
    services: { genie: { result: () => Effect.fail(denied) } },
    status: 403,
    error: { code: "permission_denied", message: denied.message },
  },
  {
    request: getGenieResult,
    services: { genie: { result: () => Effect.fail(genieTimeout) } },
    status: 504,
    error: { code: "genie_timeout", message: genieTimeout.message },
  },
  {
    request: getGenieResult,
    services: { genie: { result: () => Effect.fail(genieFailed) } },
    status: 409,
    error: { code: "genie_message_unavailable", message: genieFailed.message },
  },
  {
    request: new Request("http://localhost/api/genie", {
      method: "POST",
      body: JSON.stringify({ content: "Count trips", mode: "agent" }),
      headers: { "content-type": "application/json" },
    }),
    services: { genie: { submit: () => Effect.fail(agentDisabled) } },
    status: 503,
    error: {
      code: "genie_agent_mode_unavailable",
      message: agentDisabled.message,
    },
  },
  {
    request: getGenieResult,
    services: { genie: { result: () => Effect.fail(upstreamNotModified) } },
    status: 502,
    error: {
      code: "workspace_request_failed",
      message: upstreamNotModified.message,
    },
  },
  {
    request: new Request(
      "http://localhost/api/genie/conv/messages/msg/attachments/query/csv",
      { method: "POST" },
    ),
    services: { genie: { downloadCsv: () => Effect.fail(csvTimeout) } },
    status: 504,
    error: { code: "genie_csv_timeout", message: csvTimeout.message },
  },
  {
    request: new Request("http://localhost/api/overview"),
    services: { analytics: { overview: () => Effect.fail(warehouseTimeout) } },
    status: 504,
    error: { code: "warehouse_timeout", message: warehouseTimeout.message },
  },
] as const) {
  test(`HTTP maps ${error.code} on the operation that can produce it`, async (t) => {
    const app = appFor(services);
    t.after(app.dispose);
    const response = await app.handler(request);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error });
  });
}

test("endpoints advertise their applicable failures", () => {
  const { paths } = OpenApi.fromApi(AppApi);
  assert.deepEqual(Object.keys(paths["/api/overview"]?.get?.responses ?? {}), [
    "200",
    "400",
    "403",
    "503",
    "504",
  ]);
  assert.deepEqual(
    Object.keys(paths["/api/saved-views"]?.get?.responses ?? {}),
    ["200", "400", "403", "503"],
  );
  assert.deepEqual(
    Object.keys(paths["/api/saved-views"]?.put?.responses ?? {}),
    ["200", "400", "403", "404", "409", "503"],
  );
  for (const path of ["/api/me", "/api/metadata", "/api/analysis-runs"]) {
    const responses = paths[path]?.get?.responses;
    assert.ok(responses, `${path} has a GET contract`);
    assert.equal(
      responses["400"],
      undefined,
      `${path} has no validation response`,
    );
  }
  const { analytics, analysisRuns, genie, savedViews } = AppApi.groups;
  for (const [endpoint, allowed, unrelated] of [
    [analytics.endpoints.metadata, "warehouse_timeout", "genie_csv_timeout"],
    [savedViews.endpoints.list, "lakebase_unavailable", "analysis_unavailable"],
    [
      analysisRuns.endpoints.list,
      "analysis_request_failed",
      "genie_csv_request_failed",
    ],
    [analysisRuns.endpoints.result, "warehouse_timeout", "genie_timeout"],
    [genie.endpoints.downloadCsv, "genie_csv_timeout", "genie_timeout"],
  ] as const) {
    const accepts = (code: string) =>
      [...endpoint.error].some((schema) =>
        Schema.is(schema)({ error: { code, message: "Dependency failed" } }),
      );
    assert.equal(accepts(allowed), true, `${endpoint.path} accepts ${allowed}`);
    assert.equal(
      accepts(unrelated),
      false,
      `${endpoint.path} rejects ${unrelated}`,
    );
  }
});

test("Genie recovery endpoints validate operation IDs before calling the service", async () => {
  let calls = 0;
  const unavailableGenie = () =>
    Effect.suspend(() => {
      calls++;
      return Effect.fail(unavailable("workspace", "Unavailable"));
    });
  const app = appFor({
    genie: { poll: unavailableGenie, result: unavailableGenie },
  });
  try {
    for (const path of [
      "/api/genie/bad%20id/messages/message",
      "/api/genie/conversation/messages/bad%20id/result",
    ]) {
      const response = await app.handler(
        new Request(`http://localhost${path}`),
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: {
          code: "invalid_request",
          message: "Check the request fields, dates, and ZIP code.",
        },
      });
    }
    assert.equal(calls, 0);
    for (const path of [
      "/api/genie/conversation/messages/message",
      "/api/genie/conversation/messages/message/result",
    ]) {
      assert.equal(
        (await app.handler(new Request(`http://localhost${path}`))).status,
        503,
      );
    }
    assert.equal(calls, 2);
  } finally {
    await app.dispose();
  }
});

test("unexpected defects are HTTP 500 instead of dependency failures", async () => {
  const app = appFor({
    savedViews: {
      list: () => Effect.die(new Error("private programming error")),
    },
  });
  try {
    const response = await app.handler(
      new Request("http://localhost/api/saved-views"),
    );
    assert.equal(response.status, 500);
    assert.doesNotMatch(
      await response.text(),
      /private programming error|lakebase_unavailable/,
    );
  } finally {
    await app.dispose();
  }
});

test("HTTP separates submission IDs from polling and result retrieval", async () => {
  const operation = { conversationId: "conversation", messageId: "message" };
  const calls: unknown[] = [];
  const app = appFor({
    genie: {
      submit: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return operation;
        }),
      poll: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { ...input, state: "completed" as const, status: "COMPLETED" };
        }),
      result: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { ...input, text: "Answer", queries: [] };
        }),
    },
  });
  try {
    const submitted = await app.handler(
      new Request("http://localhost/api/genie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Count trips" }),
      }),
    );
    assert.equal(submitted.status, 200);
    assert.deepEqual(await submitted.json(), operation);
    assert.deepEqual(calls, [{ content: "Count trips" }]);
    const progress = await app.handler(
      new Request("http://localhost/api/genie/conversation/messages/message"),
    );
    assert.deepEqual(await progress.json(), {
      ...operation,
      state: "completed",
      status: "COMPLETED",
    });
    const result = await app.handler(
      new Request(
        "http://localhost/api/genie/conversation/messages/message/result",
      ),
    );
    assert.deepEqual(await result.json(), {
      ...operation,
      text: "Answer",
      queries: [],
    });
    assert.deepEqual(calls, [{ content: "Count trips" }, operation, operation]);
  } finally {
    await app.dispose();
  }
});

test("current-user endpoint returns only each viewer's name/email and prevents caching", async () => {
  const app = appFor();
  try {
    for (const name of ["Avery Morgan", "Sam Rivera"]) {
      const response = await app.handler(
        new Request("http://localhost/api/me", {
          headers: {
            "X-Forwarded-Preferred-Username": name,
            "X-Forwarded-Email": "viewer@example.com",
            "X-Forwarded-User": "opaque-id",
            "X-Forwarded-Access-Token": "private-token",
          },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        name,
        email: "viewer@example.com",
      });
    }
  } finally {
    await app.dispose();
  }
});

test("Genie CSV exports use a same-origin POST and stream a downloadable attachment", async () => {
  const path = "/api/genie/conv/messages/msg/attachments/query/csv";
  let exports = 0;
  const { handler, dispose } = appFor({
    genie: {
      downloadCsv: (reference) =>
        Effect.sync(() => {
          exports++;
          assert.deepEqual(reference, {
            conversationId: "conv",
            messageId: "msg",
            attachmentId: "query",
          });
          return Stream.make(new TextEncoder().encode("count\r\n123\r\n"));
        }),
    },
  });
  try {
    const forbidden = await handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    assert.equal(forbidden.status, 400);
    assert.equal(exports, 0);
    const file = await handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    assert.equal(file.status, 200);
    assert.equal(
      file.headers.get("content-disposition"),
      'attachment; filename="genie-results.csv"',
    );
    assert.equal(file.headers.get("cache-control"), "no-store");
    assert.equal(await file.text(), "count\r\n123\r\n");
    assert.equal(exports, 1);
  } finally {
    await dispose();
  }
});

test("hosted Genie grants bind followups, reads, cancellation, and CSV to the submitting viewer", async () => {
  const calls: string[] = [];
  const chat = {
    conversationId: "chat-conversation",
    messageId: "chat-message",
  };
  const agent = {
    conversationId: "agent-conversation",
    messageId: "agent-response",
    mode: "agent" as const,
  };
  const record = <A>(name: string, value: A) =>
    Effect.sync(() => {
      calls.push(name);
      return value;
    });
  const chatMessage = {
    conversation_id: chat.conversationId,
    message_id: chat.messageId,
    status: "COMPLETED",
    attachments: [{ text: { content: "Query ready" } }],
  };
  const { handler, dispose } = appFor(
    {
      genie: "live",
      workspace: {
        requestEvents: (_path, _body, read) =>
          record(
            "agent-submit",
            Stream.make(
              new TextEncoder().encode(
                `event: response.created\ndata: ${JSON.stringify({
                  type: "response.created",
                  response: {
                    id: agent.messageId,
                    conversation_id: agent.conversationId,
                  },
                })}\n\n`,
              ),
            ),
          ).pipe(Effect.flatMap(read)),
        request: (path, method) => {
          if (path.endsWith("/start-conversation"))
            return record("submit", {
              conversation_id: chat.conversationId,
              message: chatMessage,
            });
          if (method === "POST" && path.endsWith("/messages"))
            return record("follow-up", chatMessage);
          if (path.includes("/items?"))
            return record("poll", {
              status: "completed",
              data: [],
              has_more: false,
            });
          if (path.endsWith("/cancel"))
            return record("cancel", { status: "CANCELLED" });
          if (path.endsWith("/downloads"))
            return record("download", {
              download_id: "export",
              download_id_signature: "fixture",
            });
          if (path.includes("/downloads/export?"))
            return record("download-poll", {
              statement_response: {
                statement_id: "statement",
                status: { state: "SUCCEEDED" },
                manifest: {
                  format: "CSV",
                  truncated: false,
                  total_chunk_count: 0,
                  schema: { columns: [{ name: "total" }] },
                },
              },
            });
          if (path.endsWith(`/messages/${chat.messageId}`))
            return record("result", chatMessage);
          return Effect.die(`Unexpected workspace path: ${path}`);
        },
      },
    },
    {
      DATABRICKS_APP_NAME: "test-app",
      DATABRICKS_CLIENT_SECRET: "fixture-only-secret",
      DATABRICKS_HOST: "https://workspace.invalid",
      GENIE_SPACE_ID: "space",
    },
  );
  const owner = "123@456";
  const otherViewer = "789@456";
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const request = (
    path: string,
    viewer?: string,
    grant?: string,
    init?: RequestInit,
  ) => {
    const headers = new Headers(init?.headers);
    if (viewer) headers.set("x-forwarded-user", viewer);
    if (grant) headers.set("x-genie-access", grant);
    return handler(
      new Request(`http://localhost${path}`, { ...init, headers }),
    );
  };
  const csv = (grant?: string): RequestInit => ({
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
    body: new URLSearchParams(grant ? { grant } : undefined),
  });
  const chatPath = `/api/genie/${chat.conversationId}/messages/${chat.messageId}`;
  const agentPath = `/api/genie/${agent.conversationId}/messages/${agent.messageId}?mode=agent`;
  const cancelPath = `/api/genie/${agent.conversationId}/responses/${agent.messageId}/cancel`;
  const exportPath = `${chatPath}/attachments/attachment/csv`;
  const followUp = json({
    content: "Next question",
    conversationId: chat.conversationId,
  });
  try {
    assert.equal(
      (
        await request(
          "/api/genie",
          undefined,
          undefined,
          json({ content: "First question" }),
        )
      ).status,
      403,
    );
    assert.deepEqual(calls, []);
    const chatSubmission = await request(
      "/api/genie",
      owner,
      undefined,
      json({ content: "First question" }),
    );
    const agentSubmission = await request(
      "/api/genie",
      owner,
      undefined,
      json({ content: "First question", mode: "agent" }),
    );
    assert.equal(chatSubmission.status, 200);
    assert.equal(agentSubmission.status, 200);
    const decodeOperation = Schema.decodeUnknownSync(GenieOperation);
    const { grant: chatGrant } = decodeOperation(await chatSubmission.json());
    const { grant: agentGrant } = decodeOperation(await agentSubmission.json());
    assert.ok(chatGrant && agentGrant);
    assert.match(chatGrant, /^[A-Za-z0-9_-]{43}$/);
    assert.match(agentGrant, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(chatGrant, agentGrant);

    assert.equal(
      (await request("/api/genie", owner, undefined, followUp)).status,
      403,
    );
    assert.equal(
      (await request("/api/genie", otherViewer, chatGrant, followUp)).status,
      403,
    );
    assert.equal((await request(chatPath, owner)).status, 403);
    assert.equal((await request(chatPath, otherViewer, chatGrant)).status, 403);
    assert.equal(
      (await request(`${chatPath}/result`, otherViewer, chatGrant)).status,
      403,
    );
    assert.equal((await request(agentPath, owner, chatGrant)).status, 403);
    assert.equal(
      (await request(cancelPath, otherViewer, agentGrant, { method: "POST" }))
        .status,
      403,
    );
    assert.equal(
      (await request(exportPath, otherViewer, undefined, csv(chatGrant)))
        .status,
      403,
    );
    assert.deepEqual(calls, ["submit", "agent-submit"]);

    assert.equal(
      (await request("/api/genie", owner, chatGrant, followUp)).status,
      200,
    );
    assert.equal((await request(agentPath, owner, agentGrant)).status, 200);
    const result = await request(`${chatPath}/result`, owner, chatGrant);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      ...chat,
      grant: chatGrant,
      text: "Query ready",
      queries: [],
    });
    assert.equal(
      (await request(cancelPath, owner, agentGrant, { method: "POST" })).status,
      200,
    );
    const download = await request(
      exportPath,
      owner,
      undefined,
      csv(chatGrant),
    );
    assert.equal(download.status, 200);
    assert.equal(await download.text(), '"total"\r\n');
    assert.deepEqual(calls, [
      "submit",
      "agent-submit",
      "follow-up",
      "poll",
      "result",
      "cancel",
      "download",
      "download-poll",
    ]);
  } finally {
    await dispose();
  }
});
