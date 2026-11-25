import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Clock,
  Deferred,
  Effect,
  Latch,
  Queue,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import * as TestClock from "effect/testing/TestClock";
import { AppApi } from "@dsiem/analytics-shared/api";
import { Message as M } from "../src/features/genie/messages";
import { init } from "../src/features/genie/model";
import {
  GeniePolling,
  subscriptions,
} from "../src/features/genie/subscription";
import { type Context, updateGenie } from "../src/features/genie/update";
import { ApiClient } from "../src/lib/api-client";

const runPolling = (
  model: SubscriptionRef.SubscriptionRef<ReturnType<typeof init>>,
  dispatch: (message: typeof M.Type) => Effect.Effect<void>,
) => {
  const { geniePoll, geniePollMessages } = subscriptions;
  return Stream.merge(
    SubscriptionRef.changes(model).pipe(
      Stream.map(geniePoll.modelToDependencies),
      Stream.changesWith(Schema.toEquivalence(geniePoll.dependenciesSchema)),
      Stream.switchMap(geniePoll.dependenciesToStream),
    ),
    geniePollMessages.dependenciesToStream({}),
  ).pipe(Stream.runForEach(dispatch));
};

test("the turn deadline aborts an in-flight Genie poll and pauses once", async () => {
  const operation = { conversationId: "conversation", messageId: "message" };
  const target = { id: "turn", operation };
  const context: Context = {
    filters: {},
    context: { page: "genie", title: "Genie" },
  };
  const restored = updateGenie(
    init(),
    M.RestoredConversation({
      turns: [{ ...target, question: "Chat question", state: "waiting" }],
      persistenceError: "",
    }),
    context,
  ).model;

  await Effect.runPromise(
    Effect.gen(function* () {
      const firstStarted = yield* Latch.make();
      const stalled = yield* Deferred.make<AbortSignal>();
      let calls = 0;
      const httpClient = HttpClient.withScope(
        HttpClient.make((request, _url, signal) =>
          Effect.gen(function* () {
            if (++calls === 1) {
              yield* firstStarted.open;
              yield* Effect.sleep("119 seconds");
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  ...operation,
                  state: "pending",
                  status: "EXECUTING_QUERY",
                }),
              );
            }
            yield* Deferred.succeed(stalled, signal);
            return yield* Effect.never;
          }),
        ),
      );
      const model = yield* SubscriptionRef.make(restored);
      const messages = yield* Queue.unbounded<typeof M.Type>();
      yield* runPolling(model, (message) =>
        Queue.offer(messages, message).pipe(Effect.asVoid),
      ).pipe(
        Effect.provideServiceEffect(
          ApiClient,
          HttpApiClient.makeWith(AppApi, {
            httpClient,
            baseUrl: "http://fixture.test",
          }),
        ),
        Effect.forkChild,
      );

      yield* firstStarted.await;
      yield* TestClock.adjust("120 seconds");
      const signal = yield* Deferred.await(stalled);
      yield* TestClock.adjust("59 seconds");
      assert.equal(signal.aborted, false);
      yield* TestClock.adjust("1 second");
      assert.equal(signal.aborted, true);
      assert.deepEqual(yield* Queue.takeAll(messages), [
        M.PolledQuestion({
          ...target,
          generation: restored.pollGenerations.turn ?? 0,
          outcome: {
            state: "paused",
            stage: "waiting",
            error:
              "Genie is taking longer than expected. Resume waiting for this answer.",
          },
        }),
      ]);
    }).pipe(
      Effect.provide(GeniePolling.layer),
      Effect.provide(TestClock.layer()),
    ),
  );
});

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
      yield* runPolling(model, (message) =>
        Effect.gen(function* () {
          assert.ok(message._tag === "PolledQuestion");
          yield* SubscriptionRef.update(
            model,
            (current) => updateGenie(current, message, context).model,
          );
          yield* Queue.offer(finished, message.id);
        }),
      ).pipe(Effect.forkChild);

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
      Effect.provide(GeniePolling.layer),
      Effect.provide(TestClock.layer()),
    ),
  );
});

test(
  "stopping an Agent turn leaves another restored turn's deadline intact",
  { timeout: 2000 },
  async () => {
    const context: Context = {
      filters: {},
      context: { page: "genie", title: "Genie" },
    };
    const agent = {
      conversationId: "conversation",
      messageId: "agent",
      mode: "agent" as const,
    };
    const chat = { conversationId: "conversation", messageId: "chat" };
    const restored = updateGenie(
      init(),
      M.RestoredConversation({
        turns: [
          {
            id: "agent",
            question: "Agent question",
            state: "waiting",
            operation: agent,
          },
          {
            id: "chat",
            question: "Chat question",
            state: "waiting",
            operation: chat,
          },
        ],
        persistenceError: "",
      }),
      context,
    ).model;

    const started = Latch.makeUnsafe();
    let agentSignal: AbortSignal | undefined;
    const httpClient = HttpClient.withScope(
      HttpClient.make((request, url, signal) =>
        Effect.gen(function* () {
          if (url.pathname.endsWith("/agent")) {
            yield* started.open;
            if ((yield* Clock.currentTimeMillis) >= 165_000) {
              agentSignal = signal;
              return yield* Effect.never;
            }
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                ...agent,
                state: "pending",
                status: "pending",
              }),
            );
          }
          assert.ok(url.pathname.endsWith("/chat"));
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              ...chat,
              state: "pending",
              status: "EXECUTING_QUERY",
            }),
          );
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const model = yield* SubscriptionRef.make(restored);
        const dispatch = (message: Parameters<typeof updateGenie>[1]) =>
          SubscriptionRef.update(
            model,
            (current) => updateGenie(current, message, context).model,
          );
        yield* runPolling(model, dispatch).pipe(Effect.forkChild);
        yield* started.await;
        yield* TestClock.adjust("170 seconds");
        yield* dispatch(M.StopTurn({ id: "agent" }));
        yield* TestClock.adjust("5 seconds");
        const stopped = (yield* SubscriptionRef.get(model)).turns[0];
        assert.equal(stopped?.state, "stopping");
        const abortedOnStop = agentSignal?.aborted;
        yield* dispatch(
          M.ChangedTurn({
            turn: {
              id: "agent",
              question: "Agent question",
              state: "waiting",
              operation: agent,
            },
          }),
        );
        yield* TestClock.adjust("5 seconds");

        assert.equal(
          (yield* SubscriptionRef.get(model)).turns[1]?.state,
          "paused",
          "Chat must pause at its original deadline",
        );
        assert.equal(
          abortedOnStop,
          true,
          "Stopping must abort the in-flight Agent poll",
        );
      }).pipe(
        Effect.provideServiceEffect(
          ApiClient,
          HttpApiClient.makeWith(AppApi, {
            httpClient,
            baseUrl: "http://fixture.test",
          }),
        ),
        Effect.provide(GeniePolling.layer),
        Effect.provide(TestClock.layer()),
      ),
    );
  },
);

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
          const settled = yield* Latch.make();
          yield* runPolling(model, (message) =>
            Effect.gen(function* () {
              yield* SubscriptionRef.update(
                model,
                (current) => updateGenie(current, message, context).model,
              );
              yield* settled.open;
            }),
          ).pipe(Effect.forkChild);

          yield* firstRead.await;
          yield* TestClock.adjust("25 seconds");
          assert.equal(
            (yield* SubscriptionRef.get(model)).turns[0]?.state,
            "waiting",
          );

          visible = becomesVisible;
          yield* TestClock.adjust("5 seconds");
          yield* settled.await;
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
          Effect.provide(GeniePolling.layer),
          Effect.provide(TestClock.layer()),
        ),
      );
    },
  );
}
