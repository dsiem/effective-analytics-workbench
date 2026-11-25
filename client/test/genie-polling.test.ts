import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber, Latch, Queue, Stream, SubscriptionRef } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import * as TestClock from "effect/testing/TestClock";
import { AppApi } from "@dsiem/analytics-shared/api";
import { Message as M } from "../src/features/genie/messages";
import { init } from "../src/features/genie/model";
import { subscriptions } from "../src/features/genie/subscription";
import { type Context, updateGenie } from "../src/features/genie/update";
import { ApiClient } from "../src/lib/api-client";

test("finishing one restored Genie wait preserves the others' polling cadence", async () => {
  const context: Context = {
    filters: {},
    context: { page: "genie", title: "Genie" },
  };
  const ids = ["first", "second"];
  const restored = updateGenie(
    init(),
    M.RestoredConversation({
      turns: ids.map((id) => ({
        id,
        question: id,
        state: "waiting",
        operation: { conversationId: "conversation", messageId: id },
      })),
      persistenceError: "",
    }),
    context,
  ).model;
  const secondStarted = Latch.makeUnsafe();
  let secondPolls = 0;
  const httpClient = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const messageId = url.pathname.split("/").at(-1);
      assert.ok(messageId === "first" || messageId === "second");
      if (messageId === "first") {
        yield* secondStarted.await;
      } else {
        secondPolls++;
        yield* secondStarted.open;
      }
      const pending = messageId === "second" && secondPolls === 1;
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          conversationId: "conversation",
          messageId,
          state: pending ? "pending" : "completed",
          status: pending ? "EXECUTING_QUERY" : "COMPLETED",
        }),
      );
    }),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const model = yield* SubscriptionRef.make(restored);
      const finished = yield* Queue.unbounded<string>();
      const { geniePoll } = subscriptions;
      yield* SubscriptionRef.changes(model).pipe(
        Stream.map(geniePoll.modelToDependencies),
        Stream.changesWith(geniePoll.keepAliveEquivalence),
        Stream.switchMap((deps) =>
          geniePoll.dependenciesToStream(deps, () => deps),
        ),
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            assert.ok(message._tag === "PolledQuestion");
            yield* SubscriptionRef.update(
              model,
              (current) => updateGenie(current, message, context).model,
            );
            yield* Queue.offer(finished, message.id);
          }),
        ),
        Effect.forkChild,
      );

      assert.equal(yield* Queue.take(finished), "first");
      yield* TestClock.adjust("500 millis");
      assert.equal(secondPolls, 1);
      yield* TestClock.adjust("500 millis");
      assert.equal(yield* Queue.take(finished), "second");
      assert.equal(secondPolls, 2);
      assert.deepEqual(
        (yield* SubscriptionRef.get(model)).turns.map(({ state }) => state),
        ["retrieving", "retrieving"],
      );
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
});

for (const becomesVisible of [true, false]) {
  test(
    becomesVisible
      ? "Agent polling retrieves a turn that becomes visible within its grace period"
      : "Agent polling pauses a turn that remains unresolved for 30 seconds",
    { timeout: 2000 },
    async () => {
      const context: Context = {
        filters: {},
        context: { page: "genie", title: "Genie" },
      };
      const operation = {
        conversationId: "conversation",
        messageId: "response",
        mode: "agent" as const,
      };
      const restored = updateGenie(
        init(),
        M.RestoredConversation({
          turns: [
            {
              id: "turn",
              question: "Agent question",
              state: "waiting",
              operation,
            },
          ],
          persistenceError: "",
        }),
        context,
      ).model;
      const firstRead = Latch.makeUnsafe();
      let visible = false;
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          const response = HttpClientResponse.fromWeb(request, new Response());
          const data = new TextEncoder().encode(
            JSON.stringify({
              ...operation,
              state: visible ? "completed" : "unresolved",
              status: visible ? "completed" : "RESPONSE_NOT_VISIBLE",
            }),
          );
          yield* firstRead.open;
          return Object.defineProperty(response, "arrayBuffer", {
            value: Effect.succeed(data.buffer),
          });
        }),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const model = yield* SubscriptionRef.make(restored);
          const { geniePoll } = subscriptions;
          const deps = geniePoll.modelToDependencies(restored);
          const polling = yield* geniePoll
            .dependenciesToStream(deps, () => deps)
            .pipe(
              Stream.runForEach((message) =>
                SubscriptionRef.update(
                  model,
                  (current) => updateGenie(current, message, context).model,
                ),
              ),
              Effect.forkChild,
            );

          yield* firstRead.await;
          yield* TestClock.adjust("25 seconds");
          assert.equal(
            (yield* SubscriptionRef.get(model)).turns[0]?.state,
            "waiting",
          );

          visible = becomesVisible;
          yield* TestClock.adjust("5 seconds");
          yield* Fiber.join(polling);
          const turn = (yield* SubscriptionRef.get(model)).turns[0];
          assert.ok(turn && "operation" in turn);
          assert.deepEqual(turn.operation, operation);
          if (becomesVisible) {
            assert.equal(turn.state, "retrieving");
          } else {
            assert.equal(turn.state, "paused");
            assert.equal(turn.stage, "waiting");
          }
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
    },
  );
}
