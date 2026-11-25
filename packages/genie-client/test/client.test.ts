import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { makeGenieClient, type GenieRequest } from "../src/index.js";

test("Genie results keep attachment order, contents, and all returned inline rows", async () => {
  const rows = Array.from({ length: 125 }, () => ["1", null]);
  const calls: GenieRequest[] = [];
  const client = makeGenieClient({
    spaceId: "test space",
    request: (request) =>
      Effect.sync(() => {
        calls.push(request);
        switch (request.kind) {
          case "submit":
            return {
              conversation_id: "conversation",
              message: { message_id: "message" },
            };
          case "message":
            return {
              conversation_id: "conversation",
              message_id: "message",
              status: "COMPLETED",
              attachments: [
                { text: { content: "Sample results" } },
                { attachment_id: "query", query: { query: "SELECT 1, NULL" } },
                { suggested_questions: { questions: ["Compare results?"] } },
                { attachment_id: "viz", viz: { query_attachment_id: "query" } },
              ],
            };
          case "query-result":
            return {
              statement_response: {
                manifest: {
                  total_row_count: 250,
                  schema: {
                    columns: [
                      { name: "one", type_name: "INT" },
                      { name: "empty" },
                    ],
                  },
                },
                result: { data_array: rows, next_chunk_index: 1 },
              },
            };
        }
      }),
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const operation = yield* client.submit({
        content: "Show sample results",
      });
      const progress = yield* client.poll(operation);
      assert.equal(progress.state, "completed");
      return yield* client.result(operation);
    }),
  );
  assert.deepEqual(
    calls.map(({ kind }) => kind),
    ["submit", "message", "message", "query-result"],
  );
  assert.deepEqual(calls[0], {
    kind: "submit",
    method: "POST",
    path: "/api/2.0/genie/spaces/test%20space/start-conversation",
    body: { content: "Show sample results" },
  });
  assert.deepEqual(result, {
    conversationId: "conversation",
    messageId: "message",
    attachments: [
      { kind: "text", content: "Sample results" },
      {
        kind: "query",
        attachmentId: "query",
        sql: "SELECT 1, NULL",
        columns: [{ name: "one", typeName: "INT" }, { name: "empty" }],
        rows,
        truncated: false,
        totalRowCount: 250,
        nextChunkIndex: 1,
      },
      {
        kind: "suggested-questions",
        payload: { questions: ["Compare results?"] },
      },
      {
        kind: "visualization",
        attachmentId: "viz",
        payload: { query_attachment_id: "query" },
      },
    ],
  });
});

const readQueryResult = (statement: unknown) => {
  const operation = { conversationId: "conversation", messageId: "message" };
  const client = makeGenieClient({
    spaceId: "space",
    request: ({ kind }) =>
      Effect.succeed(
        kind === "query-result"
          ? { statement_response: statement }
          : {
              conversation_id: operation.conversationId,
              message_id: operation.messageId,
              status: "COMPLETED",
              attachments: [
                { attachment_id: "query", query: { query: "SELECT 1" } },
              ],
            },
      ),
  });
  return client.result(operation);
};

for (const [status, state] of [
  ["PENDING", "pending"],
  ["RUNNING", "pending"],
  ["CANCELED", "unavailable"],
  ["CLOSED", "unavailable"],
] as const) {
  test(`Chat reports a ${status} attachment as ${state}`, async () => {
    const result = await Effect.runPromise(
      Effect.result(readQueryResult({ status: { state: status } })),
    );
    assert.equal(result._tag, "Failure", JSON.stringify(result));
    assert.equal(result.failure._tag, "GenieQueryUnavailable");
    assert.equal(result.failure.attachmentId, "query");
    assert.equal(result.failure.state, state);
    assert.equal(result.failure.status, status);
  });
}

test("Chat preserves SQL diagnostics for a failed attachment", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      readQueryResult({
        status: {
          state: "FAILED",
          sql_state: "42601",
          error: { error_code: "BAD_REQUEST" },
        },
      }),
    ),
  );
  assert.equal(result._tag, "Failure");
  assert.equal(result.failure._tag, "GenieQueryFailed");
  assert.equal(result.failure.attachmentId, "query");
  assert.equal(result.failure.sqlState, "42601");
  assert.equal(result.failure.errorCode, "BAD_REQUEST");
});

const columns = [{ name: "one" }];
const manifest = { schema: { columns } };

test("Chat rejects malformed statement status and missing SQL result data", async () => {
  for (const statement of [
    { status: { state: "UNKNOWN" }, manifest, result: { data_array: [["1"]] } },
    { status: {} },
    { status: { state: "SUCCEEDED" } },
    { status: { state: "SUCCEEDED" }, manifest },
    { manifest, result: {} },
    {},
  ]) {
    const result = await Effect.runPromise(
      Effect.result(readQueryResult(statement)),
    );
    assert.equal(result._tag, "Failure", JSON.stringify(result));
    assert.equal(result.failure._tag, "GenieResponseError");
  }
});

test("Chat rejects negative and fractional row counts and chunk indices", async () => {
  for (const value of [-1, 0.5]) {
    const rows = { data_array: [] };
    for (const statement of [
      { manifest: { ...manifest, total_row_count: value }, result: rows },
      { manifest, result: { ...rows, next_chunk_index: value } },
    ]) {
      const error = await Effect.runPromise(
        Effect.flip(readQueryResult(statement)),
      );
      assert.equal(error._tag, "GenieResponseError");
    }
  }
});

test("Chat returns column metadata for a valid zero-row SQL result", async () => {
  for (const statement of [
    { status: { state: "SUCCEEDED" }, manifest, result: { data_array: [] } },
    {
      status: { state: "SUCCEEDED" },
      manifest: { ...manifest, total_row_count: 0 },
    },
  ]) {
    const result = await Effect.runPromise(readQueryResult(statement));
    const attachment = result.attachments[0];
    assert.equal(attachment?.kind, "query");
    assert.deepEqual(attachment.columns, columns);
    assert.deepEqual(attachment.rows, []);
  }
});

test("Chat rejects query rows that disagree with column or row counts", async () => {
  for (const statement of [
    { manifest, result: { data_array: [["1"], []] } },
    { manifest, result: { data_array: [["1", "2"]] } },
    {
      manifest: { ...manifest, total_row_count: 0 },
      result: { data_array: [["1"]] },
    },
  ]) {
    const error = await Effect.runPromise(
      Effect.flip(readQueryResult(statement)),
    );
    assert.equal(error._tag, "GenieResponseError");
  }
});
