import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { makeReportAssistant } from "../src/report-assistant.js";

test("a failed wait returns a serializable receipt and resuming never resubmits", async () => {
  const methods: string[] = [];
  let available = false;
  const assistant = makeReportAssistant(
    { host: "https://workspace.example", token: "fixture", spaceId: "space" },
    { table: "repairs", filterInstructions: "" },
    async (_url, init) => {
      methods.push(init!.method!);
      if (init?.method === "POST")
        return Response.json({
          conversation_id: "c",
          message: { message_id: "m" },
        });
      return available
        ? Response.json({
            conversation_id: "c",
            message_id: "m",
            status: "COMPLETED",
            attachments: [{ text: { content: "Done" } }],
          })
        : new Response(null, { status: 503 });
    },
  );
  const question = {
    question: "Which repairs?",
    filters: {},
    context: {},
    continuation: null,
  };
  const accepted = await Effect.runPromise(assistant.submit(question));
  assert.deepEqual(methods, ["POST"]);
  const error = await Effect.runPromise(
    Effect.flip(assistant.resume(accepted)),
  );
  assert.equal(error._tag, "AnswerUnavailable");
  assert.deepEqual(error.accepted, accepted);
  available = true;
  const result = await Effect.runPromise(
    assistant.resume(structuredClone(error.accepted)),
  );
  assert.deepEqual(result.text, ["Done"]);
  const reads = methods.length;
  const invalid = await Effect.runPromise(
    Effect.flip(assistant.resume({ ...accepted, messageId: "different" })),
  );
  assert.equal(invalid._tag, "InvalidReceipt");
  const expired = await Effect.runPromise(
    Effect.flip(assistant({ ...question, continuation: "expired" })),
  );
  assert.equal(expired.message, "Start a new conversation.");
  assert.equal(methods.length, reads);
  assert.equal(methods.filter((m) => m === "POST").length, 1);
  available = false;
  const legacy = await Effect.runPromise(Effect.flip(assistant(question)));
  assert.equal(legacy._tag, "AnswerUnavailable");
  assert.equal(legacy.accepted.messageId, "m");
});
