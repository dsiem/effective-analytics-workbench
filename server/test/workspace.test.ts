import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWithOptions } from "node:util";
import {
  Cause,
  ConfigProvider,
  Console,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
} from "effect";
import { makeGenieAgentClient } from "@dsiem/genie-client";
import { FetchHttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { withApiErrors } from "../src/api-boundary.js";
import { OperationTimeout } from "../src/errors.js";
import { Settings } from "../src/settings.js";
import { Workspace } from "../src/workspace.js";

const workspace = Workspace.layer.pipe(
  Layer.provide(
    Settings.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            DATABRICKS_HOST: "https://workspace.example",
            DATABRICKS_TOKEN: "workspace-secret",
            DATABRICKS_CLIENT_ID: "client",
            DATABRICKS_CLIENT_SECRET: "oauth-secret",
          }),
        ),
      ),
    ),
  ),
);

test("workspace requests send bearer JSON with cookies and redirects disabled", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Workspace).request("/api/example", "POST", {
        question: "Count trips",
      });
    }).pipe(
      Effect.provide(workspace),
      Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
        calls.push({
          url: url instanceof Request ? url.url : url.toString(),
          init,
        });
        return Response.json({ accepted: true });
      }),
    ),
  );
  assert.deepEqual(result, { accepted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://workspace.example/api/example");
  const init = calls[0]?.init;
  assert.equal(
    new Headers(init?.headers).get("authorization"),
    "Bearer workspace-secret",
  );
  assert.equal(
    new Headers(init?.headers).get("content-type"),
    "application/json",
  );
  assert.equal(init?.credentials, "omit");
  assert.equal(init?.redirect, "error");
  const call = calls[0];
  assert.ok(call);
  assert.deepEqual(await new Request(call.url, call.init).json(), {
    question: "Count trips",
  });
});

test("workspace HTTP failures retain status, release the body, and exclude upstream content", async () => {
  let signal: AbortSignal | null | undefined;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Workspace).request("/api/example");
    }).pipe(
      Effect.provide(workspace),
      Effect.provideService(FetchHttpClient.Fetch, async (_url, init) => {
        signal = init?.signal;
        return new Response("private response content", { status: 403 });
      }),
      Effect.result,
    ),
  );
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure") {
    assert.equal(result.failure._tag, "UpstreamError");
    if (result.failure._tag === "UpstreamError")
      assert.equal(result.failure.upstreamStatus, 403);
    assert.doesNotMatch(
      JSON.stringify(result.failure),
      /private response content|workspace-secret/,
    );
  }
  assert.equal(signal?.aborted, true);
});

test("workspace transport failures retain the diagnostic cause", async () => {
  const diagnostic = new Error("connection reset");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Workspace).request("/api/example");
    }).pipe(
      Effect.provide(workspace),
      Effect.provideService(FetchHttpClient.Fetch, async () => {
        throw diagnostic;
      }),
      Effect.result,
    ),
  );
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure") {
    assert.equal(result.failure._tag, "ServiceUnavailable");
    if (result.failure._tag === "ServiceUnavailable") {
      assert.ok(result.failure.cause instanceof Error);
      assert.equal(result.failure.cause.cause, diagnostic);
    }
  }
});

test("the API error log excludes malformed workspace response text", async () => {
  const body = "fixture-body";
  const messages: unknown[][] = [];
  const log = (...args: unknown[]) => {
    messages.push(args);
  };
  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Workspace;
      return yield* Effect.flip(withApiErrors(service.request("/api/example")));
    }).pipe(
      Effect.provide(workspace),
      Effect.provideService(
        FetchHttpClient.Fetch,
        async () => new Response(body),
      ),
      Effect.provideService(Console.Console, { ...console, error: log, log }),
    ),
  );
  assert.deepEqual(response, {
    error: {
      code: "workspace_unavailable",
      message: "The Databricks request could not be completed.",
    },
  });
  assert.doesNotMatch(
    formatWithOptions({ depth: null }, messages),
    /fixture-body|workspace-secret/,
  );
  assert.deepEqual(
    messages.map((message) => message.slice(1)),
    [
      [
        "API dependency failed",
        { service: "workspace", errorTag: "ServiceUnavailable" },
      ],
    ],
  );
});

for (const stage of ["request", "body"] as const) {
  for (const stop of ["interruption", "deadline"] as const) {
    test(
      `workspace ${stop} aborts a stalled ${stage} without replaying`,
      {
        timeout: 5000,
      },
      async () => {
        const started = Latch.makeUnsafe();
        let requests = 0;
        let signal: AbortSignal | null | undefined;
        const fetch: typeof globalThis.fetch = async (_url, init) => {
          requests++;
          signal = init?.signal;
          if (stage === "request") {
            return new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
              started.openUnsafe();
            });
          }
          return new Response(
            new ReadableStream({
              start(controller) {
                signal?.addEventListener(
                  "abort",
                  () => controller.error(new Error("aborted")),
                  { once: true },
                );
                started.openUnsafe();
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        };
        const exit = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* Workspace;
            const fiber = yield* service
              .request("/api/example", "POST", {})
              .pipe(Effect.forkChild);
            yield* started.await;
            if (stop === "deadline") yield* TestClock.adjust("30 seconds");
            else yield* Fiber.interrupt(fiber);
            return yield* Fiber.await(fiber);
          }).pipe(
            Effect.provide(workspace),
            Effect.provideService(FetchHttpClient.Fetch, fetch),
            Effect.provide(TestClock.layer()),
          ),
        );
        assert.ok(Exit.isFailure(exit));
        if (stop === "interruption") assert.ok(Cause.hasInterrupts(exit.cause));
        else assert.ok(Cause.squash(exit.cause) instanceof OperationTimeout);
        assert.equal(signal?.aborted, true);
        assert.equal(requests, 1);
      },
    );
  }
}

test(
  "Agent submission returns the accepted IDs before body cancellation completes",
  { timeout: 2000 },
  async () => {
    const finishCleanup = Deferred.makeUnsafe<void>();
    let requests = 0;
    let signal: AbortSignal | null | undefined;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Workspace;
        const agent = makeGenieAgentClient({
          agentId: "space",
          requestJson: () => Effect.die("Unexpected JSON request"),
          requestEvents: ({ path, body }, read) =>
            service.requestEvents(path, body, read),
        });
        const submission = yield* agent
          .submit({ content: "Count trips" })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        const exit = submission.pollUnsafe();
        const aborted = signal?.aborted;
        yield* Deferred.succeed(finishCleanup, undefined);
        assert.ok(
          exit,
          "Agent acceptance must return before body cancellation completes",
        );
        assert.equal(aborted, true);
        return yield* Fiber.join(submission);
      }).pipe(
        Effect.provide(workspace),
        Effect.provideService(FetchHttpClient.Fetch, async (_url, init) => {
          requests++;
          signal = init?.signal;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: response.created\ndata: {"type":"response.created","response":{"id":"response","conversation_id":"conversation"}}\n\n',
                  ),
                );
              },
              cancel: () => Effect.runPromise(Deferred.await(finishCleanup)),
            }),
          );
        }),
        Effect.provide(TestClock.layer()),
      ),
    );
    assert.deepEqual(result, {
      conversationId: "conversation",
      responseId: "response",
    });
    assert.equal(requests, 1);
  },
);
