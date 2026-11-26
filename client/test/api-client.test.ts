import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Fiber, Latch } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import * as TestClock from "effect/testing/TestClock";
import { AppApi, type ApiError } from "@dsiem/analytics-shared/api";
import {
  RetrieveQuestion,
  SubmitQuestion,
} from "../src/features/genie/commands";
import { ApiClient, request } from "../src/lib/api-client";
import { AccessDenied } from "../src/lib/request-state";

for (const phase of ["headers", "body"] as const) {
  test(`client deadline aborts stalled ${phase} and permits a subsequent request`, async () => {
    const started = Latch.makeUnsafe();
    let signal: AbortSignal | null | undefined;
    let stalled = true;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      if (!stalled)
        return Response.json({
          from: "2016-01-01",
          to: "2016-02-29",
          trips: 1,
        });
      signal = init?.signal;
      if (phase === "headers")
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
          started.openUnsafe();
        });
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
    await Effect.runPromise(
      Effect.gen(function* () {
        const call = () =>
          request((client) => client.analytics.metadata()).pipe(Effect.scoped);
        const pending = yield* call().pipe(Effect.forkChild);
        yield* started.await;
        yield* TestClock.adjust("119 seconds");
        assert.equal(signal?.aborted, false);
        yield* TestClock.adjust("1 second");
        const exit = yield* Fiber.await(pending);
        assert.ok(Exit.isFailure(exit));
        assert.ok(Cause.squash(exit.cause) instanceof Cause.TimeoutError);
        assert.equal(signal?.aborted, true);
        stalled = false;
        const result = yield* call();
        assert.equal(result.trips, 1);
      }).pipe(
        Effect.provideServiceEffect(
          ApiClient,
          Effect.gen(function* () {
            const httpClient = HttpClient.withScope(
              yield* HttpClient.HttpClient,
            );
            return yield* HttpApiClient.makeWith(AppApi, {
              httpClient,
              baseUrl: "http://fixture.test",
            });
          }).pipe(Effect.provide(FetchHttpClient.layer)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(TestClock.layer()),
      ),
    );
  });
}

const submissionFailures: ReadonlyArray<{
  name: string;
  status: number;
  error?: (typeof ApiError.Type)["error"];
  mode?: "agent";
  state:
    | "submission-unknown"
    | "submission-rejected"
    | "agent-mode-unavailable";
}> = [
  {
    name: "application timeout",
    status: 504,
    error: { code: "genie_timeout", message: "Submission timed out." },
    state: "submission-unknown",
  },
  {
    name: "upstream timeout",
    status: 502,
    error: {
      code: "workspace_request_failed",
      message: "Upstream timed out.",
      upstreamStatus: 408,
    },
    state: "submission-unknown",
  },
  {
    name: "upstream server failure",
    status: 502,
    error: {
      code: "workspace_request_failed",
      message: "Upstream failed.",
      upstreamStatus: 500,
    },
    state: "submission-unknown",
  },
  {
    name: "workspace connection failure",
    status: 503,
    error: { code: "workspace_unavailable", message: "Connection lost." },
    state: "submission-unknown",
  },
  {
    name: "invalid acceptance response",
    status: 200,
    state: "submission-unknown",
  },
  {
    name: "validation",
    status: 400,
    error: { code: "invalid_request", message: "Check the question fields." },
    state: "submission-rejected",
  },
  {
    name: "permission",
    status: 403,
    error: {
      code: "permission_denied",
      message: "Even Genie needs permission to send this question.",
    },
    state: "submission-rejected",
  },
  {
    name: "rate limit",
    status: 502,
    error: {
      code: "workspace_request_failed",
      message: "Too many requests.",
      upstreamStatus: 429,
    },
    state: "submission-rejected",
  },
  {
    name: "Agent mode unavailable",
    status: 503,
    error: {
      code: "genie_agent_mode_unavailable",
      message:
        "Agent mode is disabled in this Databricks workspace. Select Chat.",
    },
    mode: "agent",
    state: "agent-mode-unavailable",
  },
];

for (const { name, status, error, mode, state } of submissionFailures) {
  test(`Genie classifies ${name} as ${state} after one POST`, async () => {
    const requests: string[] = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(error ? { error } : {}, { status }),
        );
      }),
    );
    const message = await Effect.runPromise(
      SubmitQuestion({
        turn: {
          id: "turn",
          question: "Count trips",
          state: "submitting",
          ...(mode ? { mode } : {}),
        },
        conversation: null,
      }).effect.pipe(
        Effect.provideServiceEffect(
          ApiClient,
          HttpApiClient.makeWith(AppApi, {
            httpClient,
            baseUrl: "http://fixture.test",
          }),
        ),
      ),
    );

    const { turn } = message;
    assert.equal(turn.state, state);
    assert.deepEqual(requests, ["POST /api/genie"]);
    if (turn.state === "submission-unknown") {
      assert.ok(typeof turn.error === "string");
      assert.match(turn.error, /may have been accepted/);
    }
    if (error?.code === "permission_denied") {
      assert.ok("error" in turn);
      assert.deepEqual(
        turn.error,
        AccessDenied.make({ message: error.message }),
      );
    } else if (
      turn.state === "submission-rejected" ||
      turn.state === "agent-mode-unavailable"
    ) {
      assert.ok(error);
      assert.ok(typeof turn.error === "string");
      assert.ok(
        turn.error.includes(error.message),
        `Missing rejection reason in: ${turn.error}`,
      );
    }
  });
}

test("Genie retrieval receives a slow answer and the server's own timeout", async () => {
  const operation = { conversationId: "conversation", messageId: "message" };
  const turn = {
    state: "retrieving",
    operation,
    id: "turn",
    question: "Trips?",
  } as const;
  for (const status of [200, 504]) {
    const delay = status === 200 ? "145 seconds" : "181 seconds";
    const body =
      status === 200
        ? { ...operation, text: "An answer", queries: [] }
        : {
            error: {
              code: "genie_timeout",
              message: "Retrieval timed out on the server.",
            },
          };
    const httpClient = HttpClient.make((request) =>
      Effect.sleep(delay).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(request, Response.json(body, { status })),
        ),
      ),
    );
    const message = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* RetrieveQuestion({ turn }).effect.pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust(delay);
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provideServiceEffect(
          ApiClient,
          HttpApiClient.makeWith(AppApi, {
            httpClient,
            baseUrl: "http://fixture.test",
          }),
        ),
        Effect.provide(TestClock.layer()),
      ),
    );
    assert.equal(message._tag, "ChangedTurn");
    assert.equal(message.turn.state, status === 200 ? "complete" : "paused");
    if (message.turn.state === "paused")
      assert.equal(message.turn.error, "Retrieval timed out on the server.");
  }
});
