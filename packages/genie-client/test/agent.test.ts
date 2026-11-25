import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result, Stream } from "effect";
import { makeGenieAgentClient } from "../src/index.js";

const pageSize = 4;
const acceptanceEvent =
  'event: response.created\r\ndata: {"type":"response.created","response":{"id":"response","conversation_id":"conversation"}}\r\n\r\n';
const user = (responseId: string) => ({
  id: `${responseId}_input`,
  type: "message",
  role: "user",
});
const assistant = (id: string, text: string) => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});

const history = (items: ReadonlyArray<{ id: string; type: string }>) => {
  const cursors: Array<string | null> = [];
  const client = makeGenieAgentClient({
    agentId: "space",
    requestEvents: () => Effect.die("Unexpected event stream request"),
    requestJson: ({ path }) =>
      Effect.sync(() => {
        const params = new URL(path, "https://workspace.invalid").searchParams;
        const after = params.get("after");
        cursors.push(after);
        const ordered =
          params.get("order") === "desc" ? items.toReversed() : items;
        const cursorIndex = ordered.findIndex(({ id }) => id === after);
        if (after !== null) assert.notEqual(cursorIndex, -1);
        const start = cursorIndex + 1;
        const data = ordered.slice(start, start + pageSize);
        return {
          data,
          status: "in_progress",
          has_more: start + data.length < ordered.length,
          last_id: data.at(-1)?.id,
        };
      }),
  });
  return { client, cursors };
};

test("Agent submission waits for acceptance on the same connection after a retry hint", async () => {
  const encode = new TextEncoder();
  const body = Stream.concat(
    Stream.make(encode.encode("retry: 1000\r\n\r\n")),
    Stream.concat(Stream.make(encode.encode(acceptanceEvent)), Stream.never),
  );
  let submissions = 0;
  const client = makeGenieAgentClient({
    agentId: "space",
    requestJson: () => Effect.die("Unexpected JSON request"),
    requestEvents: ({ method }, read) =>
      Effect.gen(function* () {
        submissions++;
        assert.equal(method, "POST");
        return yield* read(body);
      }),
  });

  assert.deepEqual(
    await Effect.runPromise(
      client.submit({ content: "Show the latest data" }).pipe(Effect.result),
    ),
    Result.succeed({ conversationId: "conversation", responseId: "response" }),
  );
  assert.equal(submissions, 1);
});

test("Agent submission stops parsing at acceptance in a shared chunk", async () => {
  const bytes = new TextEncoder().encode(
    `${acceptanceEvent}data: ${"x".repeat(10 * 1024 * 1024)}`,
  );
  const client = makeGenieAgentClient({
    agentId: "space",
    requestJson: () => Effect.die("Unexpected JSON request"),
    requestEvents: (_request, read) => read(Stream.make(bytes)),
  });

  assert.deepEqual(
    await Effect.runPromise(
      client.submit({ content: "Show the latest data" }).pipe(Effect.result),
    ),
    Result.succeed({ conversationId: "conversation", responseId: "response" }),
  );
});

test("polling the current Agent turn leaves old history unread", async () => {
  const older = Array.from({ length: (32 * pageSize) / 2 }, (_, index) => [
    user(`older-${index}`),
    assistant(`answer-${index}`, "An older answer"),
  ]).flat();
  const { client, cursors } = history([
    ...older,
    user("current"),
    { id: "query", type: "function_call" },
  ]);
  const operation = { conversationId: "conversation", responseId: "current" };

  for (let poll = 0; poll < 2; poll++) {
    const progress = await Effect.runPromise(client.poll(operation));
    assert.equal(progress.state, "pending");
    assert.equal(progress.phase, "running-sql");
  }
  assert.deepEqual(cursors, [null, null]);
});

test("retrieves an older Agent turn across pages in its original order", async () => {
  const { client, cursors } = history([
    user("before-target"),
    assistant("previous-answer", "An older answer"),
    user("target"),
    assistant("first-answer", "First part"),
    { id: "sql", type: "function_call" },
    assistant("second-answer", "Second part"),
    user("newer"),
    assistant("newer-answer", "An unrelated answer"),
    user("current"),
    { id: "query", type: "function_call" },
  ]);
  const operation = { conversationId: "conversation", responseId: "target" };
  const result = await Effect.runPromise(client.result(operation));

  assert.deepEqual(result.attachments, [
    { kind: "text", content: "First part" },
    { kind: "text", content: "Second part" },
  ]);
  assert.deepEqual(cursors, [null, "newer_input"]);
});

test("an Agent turn absent from history has an unresolved outcome", async () => {
  const { client } = history([
    user("other"),
    assistant("other-answer", "An unrelated answer"),
  ]);
  const operation = { conversationId: "conversation", responseId: "target" };

  const progress = await Effect.runPromise(client.poll(operation));
  assert.equal(progress.state, "unresolved");
  assert.equal("phase" in progress, false);

  const unavailable = await Effect.runPromise(
    Effect.flip(client.result(operation)),
  );
  assert.equal(unavailable._tag, "GenieMessageUnavailable");
  assert.equal(unavailable.state, "unresolved");
});
