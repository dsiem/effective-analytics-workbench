import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, Deferred, Effect, Schema } from "effect";
import { Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { createAssistant } from "../src/assistant.js";
import { AssistantAnswer } from "../src/assistant-answer.js";

const Survey = Schema.Struct({
  station: Schema.String,
  window: Schema.Struct({
    days: Schema.Natural,
    metrics: Schema.Array(Schema.String),
  }),
});
type Survey = typeof Survey.Type;
type Answer = typeof AssistantAnswer.Type;
type Question = {
  readonly scope: Survey;
  readonly question: string;
  readonly continuation: string | null;
};
class SurveyService extends Context.Service<
  SurveyService,
  {
    connection: (
      scope: Survey,
    ) => Effect.Effect<{ configured: boolean; description?: string }, string>;
    answer: (turn: Question) => Effect.Effect<Answer, string>;
  }
>()("test/SurveyService") {}

const chat = createAssistant({
  scope: Survey,
  suggestion: (scope) => "Compare " + scope.station,
  setup: "Connect the station.",
  connect: (scope) =>
    Effect.flatMap(SurveyService, (service) => service.connection(scope)),
  ask: (turn) =>
    Effect.flatMap(SurveyService, (service) => service.answer(turn)),
});
const Page = defineMessageUnion({ SurveyChat: { message: chat.Message } });
const fold = (result: ReturnType<typeof chat.init>) =>
  Update.foldChildInit(result, {
    toParentMessage: (message) => Page.SurveyChat({ message }),
    toParentModel: (surveyChat) => ({ surveyChat }),
  });
type PageStep = ReturnType<typeof fold>;
const send = (step: PageStep, message: typeof chat.Message.Type) =>
  fold(chat.update(step.model.surveyChat, message));
const select = (step: PageStep, scope: Survey | null) =>
  fold(chat.setScope(step.model.surveyChat, scope));
const submit = (step: PageStep, draft: string) =>
  send(send(step, chat.Message.Changed({ draft })), chat.Message.Submit());
const north: Survey = {
  station: "North",
  window: { days: 7, metrics: ["rain", "wind"] },
};
const longer: Survey = { ...north, window: { ...north.window, days: 30 } };
const answer = (continuation: string): Answer => ({
  continuation,
  text: ["Station observations."],
  tables: [],
});

function execute(step: PageStep, service: typeof SurveyService.Service) {
  assert.equal(step.commands?.length, 1);
  const command = step.commands?.[0];
  assert.ok(command);
  return Effect.runPromise(
    command.effect.pipe(Effect.provideService(SurveyService, service)),
  );
}
const available: typeof SurveyService.Service = {
  connection: () => Effect.succeed({ configured: true }),
  answer: () => Effect.die("Unexpected question"),
};
async function connect(step: PageStep, expected: Survey) {
  const reply = await execute(step, {
    ...available,
    connection(scope) {
      assert.deepEqual(scope, expected);
      return Effect.succeed({ configured: true, description: scope.station });
    },
  });
  return send(step, reply.message);
}
const idle = (step: PageStep) => assert.equal(step.commands?.length ?? 0, 0);

test("equivalent nested scope preserves the draft, in-flight turn and continuation across parent updates", async () => {
  const serviceCalls: Question[] = [];
  const service = (
    result: Effect.Effect<Answer, string>,
  ): typeof SurveyService.Service => ({
    ...available,
    answer: (turn) => {
      serviceCalls.push(turn);
      return result;
    },
  });
  const connected = await connect(fold(chat.init(north)), north);
  const drafted = send(
    connected,
    chat.Message.Changed({ draft: "First survey?" }),
  );
  const equivalent = structuredClone(north);
  const retained = select(drafted, equivalent);
  idle(retained);
  const pending = send(retained, chat.Message.Submit());
  const response = Deferred.makeUnsafe<Answer, string>();
  const first = execute(pending, service(Deferred.await(response)));
  const repeated = select(pending, equivalent);
  idle(repeated);
  idle(send(repeated, chat.Message.Submit()));
  await Effect.runPromise(Deferred.succeed(response, answer("first-token")));
  const answered = send(repeated, (await first).message);
  const followup = submit(answered, "Show daily readings.");
  const failed = await execute(
    followup,
    service(Effect.fail("Station unavailable")),
  );
  const retry = send(send(followup, failed.message), chat.Message.Submit());
  const recovered = await execute(
    retry,
    service(Effect.succeed(answer("second-token"))),
  );
  const reset = send(send(retry, recovered.message), chat.Message.Reset());
  await execute(
    submit(reset, "Fresh survey?"),
    service(Effect.succeed(answer("new-token"))),
  );
  assert.deepEqual(serviceCalls, [
    { scope: north, question: "First survey?", continuation: null },
    {
      scope: north,
      question: "Show daily readings.",
      continuation: "first-token",
    },
    {
      scope: north,
      question: "Show daily readings.",
      continuation: "first-token",
    },
    { scope: north, question: "Fresh survey?", continuation: null },
  ]);
});

for (const oldOutcome of ["success", "failure"] as const) {
  test(`late ${oldOutcome} cannot settle a new pending question after A → B → A`, async () => {
    const initial = await connect(fold(chat.init(north)), north);
    const previous = submit(initial, "Old question");
    const gate = Deferred.makeUnsafe<Answer, string>();
    const old = execute(previous, {
      ...available,
      answer: () => Deferred.await(gate),
    });
    const changed = await connect(select(previous, longer), longer);
    const returned = await connect(
      select(changed, structuredClone(north)),
      north,
    );
    const pending = submit(returned, "New question");
    const current = await execute(pending, {
      ...available,
      answer: (turn) => {
        assert.deepEqual(turn, {
          scope: north,
          question: "New question",
          continuation: null,
        });
        return Effect.succeed(answer("current-token"));
      },
    });
    await Effect.runPromise(
      oldOutcome === "success"
        ? Deferred.succeed(gate, answer("abandoned-token"))
        : Deferred.fail(gate, "Previous station went offline"),
    );
    const unchanged = send(pending, (await old).message);
    assert.deepEqual(unchanged.model, pending.model);
    const accepted = send(unchanged, current.message);
    assert.deepEqual(send(accepted, current.message).model, accepted.model);
    await execute(submit(accepted, "Continue"), {
      ...available,
      answer: (turn) => {
        assert.equal(turn.continuation, "current-token");
        return Effect.succeed(answer("last-token"));
      },
    });
  });
}

test("clearing the selection ignores a late connection, and a failed check can retry its selected scope", async () => {
  const empty = fold(chat.init(null));
  idle(empty);
  idle(submit(empty, "Unselected"));
  const check = select(empty, north);
  const late = await execute(check, available);
  const cleared = select(check, null);
  idle(cleared);
  assert.deepEqual(send(cleared, late.message).model, cleared.model);
  const next = select(cleared, longer);
  const failure = await execute(next, {
    ...available,
    connection: () => Effect.fail("Could not connect"),
  });
  const failed = send(next, failure.message);
  idle(submit(failed, "Unavailable"));
  const retry = send(failed, chat.Message.RetryConnection());
  assert.deepEqual(send(retry, late.message).model, retry.model);
  const ready = await connect(retry, longer);
  await execute(submit(ready, "Connected?"), {
    ...available,
    answer: (turn) => {
      assert.deepEqual(turn, {
        scope: longer,
        question: "Connected?",
        continuation: null,
      });
      return Effect.succeed(answer("long-survey"));
    },
  });
});

test("two embedded conversations route results to the selected child and keep separate continuations", async () => {
  const panels = defineMessageUnion({
    Current: { message: chat.Message },
    Prior: { message: chat.Message },
  });
  const current = await connect(fold(chat.init(north)), north);
  const prior = await connect(fold(chat.init(longer)), longer);
  const pendingCurrent = submit(current, "Current week");
  const pair = {
    current: pendingCurrent.model.surveyChat,
    prior: prior.model.surveyChat,
  };
  const question = chat.update(pair.prior, chat.Message.Submit());
  const result = Update.foldChildInit(question, {
    toParentModel: (prior) => ({ ...pair, prior }),
    toParentMessage: (message) => panels.Prior({ message }),
  });
  const command = result.commands?.[0];
  assert.ok(command);
  const reply = await Effect.runPromise(
    command.effect.pipe(
      Effect.provideService(SurveyService, {
        ...available,
        answer: () => Effect.succeed(answer("monthly-token")),
      }),
    ),
  );
  assert.equal(reply._tag, "Prior");
  const settled = fold(chat.update(result.model.prior, reply.message));
  await execute(submit(settled, "Monthly follow-up"), {
    ...available,
    answer: (turn) => {
      assert.deepEqual(turn, {
        scope: longer,
        question: "Monthly follow-up",
        continuation: "monthly-token",
      });
      return Effect.succeed(answer("done"));
    },
  });
  const failure = await execute(pendingCurrent, {
    ...available,
    answer: () => Effect.fail("Current survey unavailable"),
  });
  const retry = send(
    fold(chat.update(result.model.current, failure.message)),
    chat.Message.Submit(),
  );
  await execute(retry, {
    ...available,
    answer: (turn) => {
      assert.deepEqual(turn, {
        scope: north,
        question: "Current week",
        continuation: null,
      });
      return Effect.succeed(answer("weekly-token"));
    },
  });
});
