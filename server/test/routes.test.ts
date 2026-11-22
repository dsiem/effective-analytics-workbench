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
import { HttpRouter, HttpServer } from "effect/http";
import { OpenApi } from "effect/http-api";
import { AppApi } from "../../shared/api.js";
import { GenieOperation } from "../../shared/genie.js";
import { Analytics } from "../src/analytics.js";
import {
  GenieFailed,
  OperationTimeout,
  PermissionDenied,
  SavedViewConflict,
  SavedViewNotFound,
  type ServiceUnavailable,
  unavailable,
} from "../src/errors.js";
import { Genie } from "../src/genie.js";
import { Routes } from "../src/routes.js";
import { SavedViews } from "../src/saved-views.js";
import { Settings } from "../src/settings.js";
import { TripComments } from "../src/trip-comments.js";
import { Workspace } from "../src/workspace.js";

type Services = {
  genie?: Partial<typeof Genie.Service>;
  analytics?: Partial<typeof Analytics.Service>;
  savedViews?: Partial<typeof SavedViews.Service>;
};
const appFor = (
  effect: Effect.Effect<never, ServiceUnavailable> = Effect.die(
    "Unexpected service call",
  ),
  overrides: Services = {},
  env: Readonly<Record<string, string>> = {},
) =>
  HttpRouter.toWebHandler(
    Routes.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Workspace, {
            requestEvents: () =>
              Effect.die("Unexpected workspace event request"),
            accessToken: Effect.succeed(Redacted.make("unused")),
            request: () => Effect.die("Unexpected workspace request"),
          }),
          Layer.succeed(Analytics, {
            metadata: effect,
            overview: () => effect,
            trips: () => effect,
            tripMap: () => effect,
            analysisReport: () => effect,
            ...overrides.analytics,
          }),
          Layer.succeed(Genie, {
            submit: () => effect,
            poll: () => effect,
            result: () => effect,
            cancel: () => effect,
            downloadCsv: () => effect,
            ...overrides.genie,
          }),
          Layer.succeed(TripComments, {
            counts: () => effect,
            list: () => effect,
            add: () => effect,
          }),
          Layer.succeed(SavedViews, {
            list: () => effect,
            save: () => effect,
            pin: () => effect,
            remove: () => effect,
            ...overrides.savedViews,
          }),
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
      Layer.provideMerge(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

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
    request: new Request("http://localhost/api/overview"),
    services: { analytics: { overview: () => Effect.fail(warehouseTimeout) } },
    status: 504,
    error: { code: "warehouse_timeout", message: warehouseTimeout.message },
  },
] as const) {
  test(`HTTP maps ${error.code} on the operation that can produce it`, async (t) => {
    const app = appFor(undefined, services);
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
});

test("Genie recovery endpoints validate operation IDs before calling the service", async () => {
  let calls = 0;
  const app = appFor(
    Effect.suspend(() => {
      calls++;
      return Effect.fail(unavailable("genie", "Unavailable"));
    }),
  );
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
  const app = appFor(Effect.die(new Error("private programming error")));
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
  const app = appFor(undefined, {
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
  const { handler, dispose } = appFor(undefined, {
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
  const { handler, dispose } = appFor(
    undefined,
    {
      genie: {
        submit: ({ mode, conversationId }) =>
          record(
            conversationId ? "follow-up" : "submit",
            mode === "agent" ? agent : chat,
          ),
        poll: (operation) =>
          record("poll", {
            ...operation,
            state: "completed" as const,
            status: "COMPLETED",
          }),
        result: (operation) =>
          record("result", { ...operation, text: "Query ready", queries: [] }),
        cancel: ({ conversationId, responseId }) =>
          record("cancel", {
            conversationId,
            messageId: responseId,
            mode: "agent" as const,
            state: "cancelled" as const,
            status: "CANCELLED",
          }),
        downloadCsv: () =>
          record(
            "download",
            Stream.make(new TextEncoder().encode("total\r\n1\r\n")),
          ),
      },
    },
    {
      DATABRICKS_APP_NAME: "test-app",
      DATABRICKS_CLIENT_SECRET: "fixture-only-secret",
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
    assert.deepEqual(calls, ["submit", "submit"]);

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
    assert.equal(await download.text(), "total\r\n1\r\n");
    assert.deepEqual(calls, [
      "submit",
      "submit",
      "follow-up",
      "poll",
      "result",
      "cancel",
      "download",
    ]);
  } finally {
    await dispose();
  }
});
