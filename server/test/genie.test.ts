import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { unavailable, UpstreamError } from "../src/errors.js";
import { Genie } from "../src/genie.js";
import { Settings } from "../src/settings.js";
import { Workspace } from "../src/workspace.js";

const localGenie = Genie.use(({ forViewer }) => forViewer(undefined));

test("Genie accepts ID-less text and visualization attachments and retains follow-up context", async () => {
  const calls: { path: string; method: string }[] = [];
  const message = {
    message_id: "message",
    conversation_id: "conversation",
    status: "COMPLETED",
    attachments: [
      { text: { content: "There are **21,932 trips**." } },
      {
        attachment_id: "query",
        query: {
          query: "SELECT COUNT(*) AS total_trips FROM samples.nyctaxi.trips",
          description: "Trip count",
        },
      },
      { suggested_questions: { questions: ["Top pickup areas?"] } },
      { attachment_id: "chart", viz: { query_attachment_id: "query" } },
    ],
  };
  const workspace = Layer.succeed(Workspace, {
    requestEvents: () => Effect.die("Unexpected workspace event request"),
    accessToken: Effect.succeed(Redacted.make("unused")),
    request: (path, method = "GET") => {
      calls.push({ path, method });
      return Effect.succeed(
        path.endsWith("query-result")
          ? {
              statement_response: {
                manifest: {
                  schema: { columns: [{ name: "total_trips" }] },
                  total_row_count: 1,
                  truncated: false,
                },
                result: { data_array: [["21932"]] },
              },
            }
          : path.endsWith("start-conversation")
            ? { conversation_id: "conversation", message }
            : message,
      );
    },
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const genie = yield* localGenie;
      const operation = yield* genie.submit({ content: "Count trips" });
      assert.deepEqual(operation, {
        conversationId: "conversation",
        messageId: "message",
      });
      assert.equal(
        calls.length,
        1,
        "submission returns before polling or downloading results",
      );
      assert.equal((yield* genie.poll(operation)).state, "completed");
      const first = yield* genie.result(operation);
      const followup = yield* genie.submit({
        content: "Count again",
        conversationId: first.conversationId,
      });
      const second = yield* genie.result(followup);
      return { first, second };
    }).pipe(
      Effect.provide(
        Genie.layer.pipe(
          Layer.provide(workspace),
          Layer.provide(Settings.layer),
        ),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          DATABRICKS_HOST: "https://workspace.invalid",
          GENIE_SPACE_ID: "space",
        }),
      ),
    ),
  );
  assert.equal(result.first.text, "There are **21,932 trips**.");
  assert.deepEqual(result.first.queries[0]?.rows, [["21932"]]);
  assert.deepEqual(result.first.warning, {
    kind: "unsupported-attachments",
    count: 2,
  });
  assert.equal(result.second.conversationId, result.first.conversationId);
  assert.equal(
    calls.filter((call) => call.path.endsWith("start-conversation")).length,
    1,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.path.endsWith("/conversations/conversation/messages") &&
        call.method === "POST",
    ),
  );
});

const operation = { conversationId: "conversation", messageId: "message" };
const message = {
  conversation_id: operation.conversationId,
  message_id: operation.messageId,
  status: "COMPLETED",
  attachments: [
    {
      attachment_id: "query",
      query: { query: "SELECT 1", description: "One" },
    },
  ],
};
const provideGenie = (
  request: typeof Workspace.Service.request,
  env: Readonly<Record<string, string>> = {},
) =>
  Genie.layer.pipe(
    Layer.provide(
      Layer.succeed(Workspace, {
        requestEvents: () => Effect.die("Unexpected workspace event request"),
        accessToken: Effect.succeed(Redacted.make("unused")),
        request,
      }),
    ),
    Layer.provide(Settings.layer),
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          DATABRICKS_HOST: "https://workspace.invalid",
          GENIE_SPACE_ID: "space",
          ...env,
        }),
      ),
    ),
  );

test("Genie reports missing permissions during submission, polling and result retrieval", async () => {
  const forbidden = new UpstreamError({
    service: "workspace",
    upstreamStatus: 403,
    message: "private diagnostic",
  });
  const failures = await Effect.runPromise(
    Effect.gen(function* () {
      const genie = yield* localGenie;
      return [
        yield* Effect.flip(genie.submit({ content: "Count trips" })),
        yield* Effect.flip(
          genie.submit({
            content: "Again",
            conversationId: operation.conversationId,
          }),
        ),
        yield* Effect.flip(genie.poll(operation)),
        yield* Effect.flip(genie.result(operation)),
      ];
    }).pipe(Effect.provide(provideGenie(() => Effect.fail(forbidden)))),
  );
  for (const failure of failures) {
    assert.equal(failure._tag, "PermissionDenied");
    assert.match(failure.message, /Genie/);
    assert.doesNotMatch(failure.message, /private diagnostic/);
  }
});

test("a Genie warehouse access failure stops both polling and direct retrieval", async () => {
  const failed = {
    ...message,
    status: "FAILED",
    error: {
      type: "WAREHOUSE_ACCESS_MISSING_EXCEPTION",
      error: "private diagnostic",
    },
  };
  const failures = await Effect.runPromise(
    Effect.gen(function* () {
      const genie = yield* localGenie;
      return [
        yield* Effect.flip(genie.poll(operation)),
        yield* Effect.flip(genie.result(operation)),
      ];
    }).pipe(Effect.provide(provideGenie(() => Effect.succeed(failed)))),
  );
  for (const failure of failures) {
    assert.equal(failure._tag, "PermissionDenied");
    assert.equal(
      failure.message,
      "Even Genie needs permission to answer this question.",
    );
    assert.doesNotMatch(failure.message, /private diagnostic/);
  }
});

test("Genie reports denied attachment queries instead of displaying an empty result", async () => {
  for (const status of [
    {
      state: "FAILED",
      error: { error_code: "PERMISSION_DENIED", message: "private diagnostic" },
    },
    { state: "FAILED", sql_state: "42501" },
  ]) {
    const failure = await Effect.runPromise(
      Effect.flatMap(localGenie, (genie) =>
        Effect.flip(genie.result(operation)),
      ).pipe(
        Effect.provide(
          provideGenie((path) =>
            Effect.succeed(
              path.endsWith("query-result")
                ? { statement_response: { status } }
                : message,
            ),
          ),
        ),
      ),
    );
    assert.equal(failure._tag, "PermissionDenied");
    assert.match(failure.message, /Genie result/);
    assert.doesNotMatch(failure.message, /private diagnostic/);
  }
});

test("a failed result download can be retried with the same IDs without another submission", async () => {
  let submissions = 0;
  let downloads = 0;
  const diagnostic = new Error("download failed");
  const layer = provideGenie((path, method = "GET") => {
    if (method === "POST") {
      submissions++;
      return Effect.succeed({ conversation_id: "conversation", message });
    }
    if (path.endsWith("query-result")) {
      downloads++;
      return downloads === 1
        ? Effect.fail(unavailable("workspace", "Download failed", diagnostic))
        : Effect.succeed({
            statement_response: {
              manifest: {
                schema: { columns: [{ name: "one" }] },
                total_row_count: 150,
              },
              result: { data_array: Array.from({ length: 125 }, () => ["1"]) },
            },
          });
    }
    return Effect.succeed(message);
  });
  const reply = await Effect.runPromise(
    Effect.gen(function* () {
      const genie = yield* localGenie;
      const submitted = yield* genie.submit({ content: "One" });
      const failed = yield* genie.result(submitted).pipe(Effect.exit);
      assert.ok(Exit.isFailure(failed));
      const error = Cause.findErrorOption(failed.cause);
      assert.ok(
        error._tag === "Some" && error.value._tag === "ServiceUnavailable",
      );
      assert.equal(error.value.cause, diagnostic);
      return yield* genie.result(submitted);
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(submissions, 1);
  assert.equal(downloads, 2);
  assert.equal(reply.messageId, "message");
  assert.equal(reply.queries[0]?.rows.length, 100);
  assert.equal(reply.queries[0]?.truncated, true);
});

for (const status of [
  "EXECUTING_QUERY",
  "FAILED",
  "CANCELLED",
  "QUERY_RESULT_EXPIRED",
]) {
  test(`Genie polling exposes ${status} without submitting or downloading`, async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const genie = yield* localGenie;
        const progress = yield* genie.poll(operation);
        const reply = yield* genie.result(operation).pipe(Effect.exit);
        return { progress, reply };
      }).pipe(
        Effect.provide(
          provideGenie((path, method = "GET") => {
            assert.equal(method, "GET");
            calls.push(path);
            return Effect.succeed({ ...message, status });
          }),
        ),
      ),
    );
    assert.equal(
      result.progress.state,
      status === "EXECUTING_QUERY" ? "pending" : "failed",
    );
    assert.equal(result.progress.status, status);
    assert.ok(Exit.isFailure(result.reply));
    const error = Cause.findErrorOption(result.reply.cause);
    assert.ok(error._tag === "Some" && error.value._tag === "GenieFailed");
    assert.equal(error.value.status, status);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((path) => path.endsWith("/messages/message")));
  });
}

test("Genie preserves invalid upstream response diagnostics", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(localGenie, (genie) => genie.poll(operation)).pipe(
      Effect.provide(provideGenie(() => Effect.succeed({ unexpected: true }))),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(error._tag === "Some" && error.value._tag === "UpstreamError");
  assert.ok(error.value.cause && typeof error.value.cause === "object");
  assert.equal(Reflect.get(error.value.cause, "_tag"), "SchemaError");
});

test("interrupted Genie reads remain interrupted and the same operation can be resumed", async () => {
  let reads = 0;
  const layer = provideGenie(() =>
    ++reads === 1 ? Effect.interrupt : Effect.succeed(message),
  );
  const progress = await Effect.runPromise(
    Effect.gen(function* () {
      const genie = yield* localGenie;
      const interrupted = yield* genie.poll(operation).pipe(Effect.exit);
      assert.ok(Exit.isFailure(interrupted));
      assert.ok(Cause.hasInterruptsOnly(interrupted.cause));
      return yield* genie.poll(operation);
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(progress.state, "completed");
  assert.equal(progress.messageId, operation.messageId);
});

test("accepted submission IDs and status polling do not depend on result attachment decoding", async () => {
  const payload = {
    ...message,
    attachments: [
      { attachment_id: "query", query: { description: "Missing SQL" } },
      { future_attachment: {} },
    ],
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const genie = yield* localGenie;
      const accepted = yield* genie.submit({ content: "Question" });
      const followup = yield* genie.submit({
        content: "Follow-up",
        conversationId: accepted.conversationId,
      });
      const progress = yield* genie.poll(accepted);
      const downloaded = yield* genie.result(accepted).pipe(Effect.exit);
      return { accepted, followup, progress, downloaded };
    }).pipe(
      Effect.provide(
        provideGenie((path) =>
          Effect.succeed(
            path.endsWith("start-conversation")
              ? { conversation_id: "conversation", message: payload }
              : payload,
          ),
        ),
      ),
    ),
  );
  assert.deepEqual(result.accepted, operation);
  assert.deepEqual(result.followup, operation);
  assert.equal(result.progress.state, "completed");
  assert.ok(Exit.isFailure(result.downloaded));
  const error = Cause.findErrorOption(result.downloaded.cause);
  assert.ok(error._tag === "Some" && error.value._tag === "UpstreamError");
});

test("Chat counts all undisplayed attachments in its warning", async () => {
  const reply = await Effect.runPromise(
    Effect.flatMap(localGenie, (genie) => genie.result(operation)).pipe(
      Effect.provide(
        provideGenie((path) =>
          Effect.succeed(
            path.endsWith("query-result")
              ? {
                  statement_response: {
                    status: { state: "SUCCEEDED" },
                    manifest: { schema: { columns: [{ name: "one" }] } },
                    result: { data_array: [["1"]] },
                  },
                }
              : {
                  ...message,
                  attachments: [
                    { text: { content: "Trips rose 12%." } },
                    { future_attachment: { internal: "unused payload" } },
                    ...message.attachments,
                    { viz: { query_attachment_id: "query" } },
                    { another_attachment: {} },
                  ],
                },
          ),
        ),
      ),
    ),
  );
  assert.equal(reply.text, "Trips rose 12%.");
  assert.deepEqual(reply.queries[0]?.rows, [["1"]]);
  assert.deepEqual(reply.warning, {
    kind: "unsupported-attachments",
    count: 3,
  });
});

test("Chat marks inline results as a preview when another chunk is available", async () => {
  const reply = await Effect.runPromise(
    Effect.flatMap(localGenie, (genie) => genie.result(operation)).pipe(
      Effect.provide(
        provideGenie((path) =>
          Effect.succeed(
            path.endsWith("query-result")
              ? {
                  statement_response: {
                    status: { state: "SUCCEEDED" },
                    manifest: { schema: { columns: [{ name: "one" }] } },
                    result: { data_array: [["1"]], next_chunk_index: 1 },
                  },
                }
              : message,
          ),
        ),
      ),
    ),
  );
  assert.equal(reply.queries[0]?.truncated, true);
});

test("Genie builds structured filter context server-side for initial and follow-up questions", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const filters = { from: "2016-01-10", to: "2016-01-20", zip: "10001" };
  const context = {
    page: "overview" as const,
    title: "Trips by pickup hour",
    data: JSON.stringify({ hourly: [{ hour: 18, trips: 200 }] }),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const genie = yield* localGenie;
      yield* genie.submit({ content: "Count trips", filters, context });
      yield* genie.submit({
        content: "Count all trips",
        conversationId: "conversation",
        filters: {},
        context: { page: "map", title: "Pickup activity" },
      });
      yield* genie.submit({
        content: "One day",
        conversationId: "conversation",
        filters: { from: "2016-01-10", to: "2016-01-10" },
      });
      yield* genie.submit({
        content: "From this date",
        filters: { from: "2016-01-10" },
      });
      yield* genie.submit({
        content: "Through this date",
        filters: { to: "2016-01-20" },
      });
    }).pipe(
      Effect.provide(
        Genie.layer.pipe(
          Layer.provide(
            Layer.succeed(Workspace, {
              requestEvents: () =>
                Effect.die("Unexpected workspace event request"),
              accessToken: Effect.succeed(Redacted.make("unused")),
              request: (path, _method, body) =>
                Effect.sync(() => {
                  requests.push({ path, body });
                  return path.endsWith("start-conversation")
                    ? {
                        conversation_id: "conversation",
                        message: { message_id: "message" },
                      }
                    : {
                        conversation_id: "conversation",
                        message_id: "message",
                      };
                }),
            }),
          ),
          Layer.provide(Settings.layer),
        ),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          DATABRICKS_HOST: "https://workspace.invalid",
          GENIE_SPACE_ID: "space",
          TRIP_SNAPSHOT_TABLE: "custom.taxi.trips",
        }),
      ),
    ),
  );
  assert.equal(requests.length, 5);
  const first = requests[0];
  assert.ok(
    first?.body && typeof first.body === "object" && "content" in first.body,
  );
  assert.equal(first.path.endsWith("start-conversation"), true);
  assert.equal(typeof first.body.content, "string");
  const content = String(first.body.content);
  assert.ok(content.startsWith("Count trips\n"));
  assert.ok(content.includes(JSON.stringify(filters)));
  assert.match(content, /custom.taxi.trips/);
  assert.ok(content.includes(JSON.stringify(context)));
  const followup = requests[1];
  assert.ok(
    followup?.body &&
      typeof followup.body === "object" &&
      "content" in followup.body,
  );
  assert.ok(followup.path.endsWith("/conversations/conversation/messages"));
  assert.match(String(followup.body.content), /\n\{\}\n/);
  assert.ok(String(followup.body.content).includes('"page":"map"'));
  assert.ok(!String(followup.body.content).includes("Trips by pickup hour"));
  for (const [index, filters] of [
    [2, { from: "2016-01-10", to: "2016-01-10" }],
    [3, { from: "2016-01-10" }],
    [4, { to: "2016-01-20" }],
  ] as const) {
    const body = requests[index]?.body;
    assert.ok(body && typeof body === "object" && "content" in body);
    assert.ok(String(body.content).includes(JSON.stringify(filters)));
  }
});

test(
  "Agent mode releases the acceptance stream and retrieves the matching paginated report",
  { timeout: 5000 },
  async () => {
    const config = ConfigProvider.fromEnvRecord({
      DATABRICKS_HOST: "https://workspace.invalid",
      DATABRICKS_TOKEN: "fixture-token",
      GENIE_SPACE_ID: "space",
    });
    let released = false;
    let submissions = 0;
    let itemsReads = 0;
    const body = new TextEncoder().encode(
      'event: response.created\r\ndata: {"type":"response.created","response":{"id":"response","conversation_id":"conversation"}}\r\n\r\n',
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const genie = yield* localGenie;
        const accepted = yield* genie.submit({
          mode: "agent",
          content: "Compare trip counts",
          conversationId: "conversation",
        });
        assert.deepEqual(accepted, {
          mode: "agent" as const,
          conversationId: "conversation",
          messageId: "response",
        });
        assert.equal(released, true);
        const running = yield* genie.poll(accepted);
        assert.equal(running.state, "pending");
        assert.equal(running.phase, "running-sql");
        const reporting = yield* genie.poll(accepted);
        assert.equal(reporting.state, "pending");
        assert.equal(reporting.phase, "preparing-report");
        assert.equal((yield* genie.poll(accepted)).state, "completed");
        return yield* genie.result(accepted);
      }).pipe(
        Effect.provide(
          Genie.layer.pipe(
            Layer.provide(Workspace.layer),
            Layer.provide(Settings.layer),
          ),
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, config),
        Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
          const request = new Request(input, init);
          const { pathname, searchParams } = new URL(request.url);
          assert.equal(
            request.headers.get("authorization"),
            "Bearer fixture-token",
          );
          if (request.method === "POST") {
            submissions++;
            assert.equal(pathname, "/api/2.0/genie/agents/space/responses");
            assert.equal(request.headers.get("accept"), "text/event-stream");
            const payload = Schema.decodeUnknownSync(
              Schema.Struct({
                conversation_id: Schema.String,
                input: Schema.Tuple([
                  Schema.Struct({
                    type: Schema.Literal("message"),
                    role: Schema.Literal("user"),
                    content: Schema.Tuple([
                      Schema.Struct({
                        type: Schema.Literal("input_text"),
                        text: Schema.String,
                      }),
                    ]),
                  }),
                ]),
              }),
            )(await request.json());
            assert.equal(payload.conversation_id, "conversation");
            assert.match(
              payload.input[0].content[0].text,
              /^Compare trip counts/,
            );
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(body.slice(0, 21));
                  controller.enqueue(body.slice(21));
                },
                cancel() {
                  released = true;
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            );
          }
          assert.equal(
            pathname,
            "/api/2.0/genie/agents/space/conversations/conversation/items",
          );
          assert.equal(searchParams.get("order"), "desc");
          if (searchParams.has("after")) {
            assert.equal(searchParams.get("after"), "response-new_input");
            return Response.json({
              status: "in_progress",
              has_more: true,
              last_id: "response_input",
              data: [
                {
                  id: "answer",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "Trips increased [1](https://workspace.invalid/genie).",
                    },
                    {
                      type: "output_text",
                      text: "Table preview",
                      metadata: {
                        status: "available",
                        sql: "SELECT 2",
                        columns: [{ name: "trips", type: "INT" }],
                        preview_rows: [["2"]],
                        total_row_count: 5,
                      },
                    },
                  ],
                },
                { id: "response_input", type: "message", role: "user" },
              ],
            });
          }
          itemsReads++;
          if (itemsReads > 2) {
            return Response.json({
              status: "in_progress",
              has_more: true,
              last_id: "response-new_input",
              data: [
                {
                  id: "other",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Another turn" }],
                },
                { id: "response-new_input", type: "message", role: "user" },
              ],
            });
          }
          return Response.json({
            status: "in_progress",
            has_more: false,
            last_id: "response_input",
            data: [
              itemsReads === 1
                ? {
                    id: "query",
                    type: "function_call_output",
                    status: "in_progress",
                  }
                : {
                    id: "draft-report",
                    type: "message",
                    role: "assistant",
                    status: "in_progress",
                  },
              { id: "response_input", type: "message", role: "user" },
            ],
          });
        }),
      ),
    );

    assert.equal(submissions, 1);
    assert.equal(result.mode, "agent");
    assert.match(result.text, /^Trips increased \[1\]/);
    assert.deepEqual(result.queries, [
      {
        sql: "SELECT 2",
        description: "Query result",
        columns: ["trips"],
        rows: [["2"]],
        truncated: true,
      },
    ]);
  },
);

test("Agent mode reports workspace feature gating separately from a missing agent", async () => {
  const config = ConfigProvider.fromEnvRecord({
    DATABRICKS_HOST: "https://workspace.invalid",
    DATABRICKS_TOKEN: "fixture-token",
    GENIE_SPACE_ID: "space",
  });
  const layer = Genie.layer.pipe(
    Layer.provide(Workspace.layer),
    Layer.provide(Settings.layer),
  );

  for (const [upstreamCode, expected] of [
    ["FEATURE_DISABLED", "ServiceUnavailable"],
    ["NOT_FOUND", "UpstreamError"],
  ] as const) {
    const error = await Effect.runPromise(
      Effect.flatMap(localGenie, (genie) =>
        Effect.flip(genie.submit({ content: "Count trips", mode: "agent" })),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(ConfigProvider.ConfigProvider, config),
        Effect.provideService(FetchHttpClient.Fetch, async () =>
          Response.json(
            { error_code: upstreamCode, message: "private diagnostic" },
            { status: 404 },
          ),
        ),
      ),
    );
    assert.equal(error._tag, expected);
    assert.doesNotMatch(JSON.stringify(error), /private diagnostic/);
    if (error._tag === "ServiceUnavailable") {
      assert.equal(error.service, "genie_agent_mode");
      assert.match(error.message, /workspace/);
    } else if (error._tag === "UpstreamError") {
      assert.equal(error.upstreamStatus, 404);
    }
  }
});

test("Agent submission without an acceptance event fails as an invalid response", async () => {
  const layer = Genie.layer.pipe(
    Layer.provide(Workspace.layer),
    Layer.provide(Settings.layer),
  );
  let submissions = 0;
  const error = await Effect.runPromise(
    Effect.flatMap(localGenie, (genie) =>
      Effect.flip(genie.submit({ content: "Count trips", mode: "agent" })),
    ).pipe(
      Effect.provide(layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          DATABRICKS_HOST: "https://workspace.invalid",
          DATABRICKS_TOKEN: "fixture-token",
          GENIE_SPACE_ID: "space",
        }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, async () => {
        submissions++;
        return new Response("event: response.failed\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    ),
  );
  assert.equal(error._tag, "UpstreamError");
  assert.equal(error.service, "genie");
  assert.equal(submissions, 1);
});

test("Agent cancellation uses the accepted response IDs and returns Databricks' outcome", async () => {
  for (const [status, state] of [
    ["CANCELLED", "cancelled"],
    ["COMPLETED", "completed"],
  ]) {
    const calls: Array<{ path: string; method: string }> = [];
    const progress = await Effect.runPromise(
      Effect.flatMap(localGenie, (genie) =>
        genie.cancel({
          conversationId: "agent-conversation",
          responseId: "agent-response",
        }),
      ).pipe(
        Effect.provide(
          provideGenie((path, method = "GET") => {
            calls.push({ path, method });
            return Effect.succeed({ status });
          }),
        ),
      ),
    );
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/api/2.0/genie/agents/space/conversations/agent-conversation/responses/agent-response/cancel",
      },
    ]);
    assert.deepEqual(progress, {
      conversationId: "agent-conversation",
      messageId: "agent-response",
      mode: "agent",
      status,
      state,
    });
  }
});

test("Genie holds CSV transfer capacity until the body is interrupted", async () => {
  const layer = provideGenie(
    (_, method) =>
      Effect.succeed(
        method === "POST"
          ? {
              download_id: "download",
              download_id_signature: "fixture",
            }
          : {
              statement_response: {
                statement_id: "statement",
                status: { state: "SUCCEEDED" },
                manifest: {
                  format: "CSV",
                  truncated: false,
                  total_chunk_count: 0,
                  schema: { columns: [{ name: "trip" }] },
                },
              },
            },
      ),
    { GENIE_MAX_CONCURRENCY: "1" },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const genie = yield* localGenie;
      const first = yield* genie.downloadCsv({
        ...operation,
        attachmentId: "query",
      });
      const second = yield* genie.downloadCsv({
        ...operation,
        attachmentId: "query",
      });
      const reading = Latch.makeUnsafe();
      const firstTransfer = yield* Stream.runForEach(first, () =>
        reading.open.pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* reading.await;

      const secondTransfer = yield* Stream.runCollect(second).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      assert.equal(
        secondTransfer.pollUnsafe(),
        undefined,
        "The second transfer must wait for the first body to close",
      );

      yield* Fiber.interrupt(firstTransfer);
      const bytes = yield* Fiber.join(secondTransfer);
      assert.equal(new TextDecoder().decode(bytes[0]), '"trip"\r\n');
    }).pipe(Effect.provide(layer)),
  );
});
