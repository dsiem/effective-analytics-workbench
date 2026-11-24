import { Clock, Effect, Result, Schema, Stream } from "effect";
import { genieAccessHeaders } from "../../../../shared/api";
import { Subscription } from "foldkit";
import type { GenieAgentPhase } from "../../../../shared/genie";
import { type ApiClient, request } from "../../lib/api-client";
import { failure } from "../../lib/command-result";
import { Message as M, type Message, PollTarget } from "./messages";
import type { Model } from "./model";

const PollSelection = Schema.Struct({
  generation: Schema.Int,
  waiting: Schema.Array(PollTarget),
});
const agentVisibilityGraceMs = 30_000;

function poll(target: typeof PollTarget.Type, generation: number) {
  const complete = (outcome: ReturnType<typeof M.PolledQuestion>["outcome"]) =>
    M.PolledQuestion({ ...target, generation, outcome });
  const pause = (error: string) =>
    complete({ state: "paused", stage: "waiting", error });
  const read = request((client) =>
    client.genie.poll({
      headers: genieAccessHeaders(target.operation.grant),
      params: target.operation,
      query: target.operation.mode ? { mode: target.operation.mode } : {},
    }),
  ).pipe(Effect.scoped, Effect.mapError(failure), Effect.result);
  const agent = target.operation.mode === "agent";
  type PollState =
    | { readonly step: "first" }
    | {
        readonly step: "next";
        readonly deadline: number;
        readonly phase: GenieAgentPhase | undefined;
        readonly unresolvedSince: number | undefined;
      }
    | { readonly step: "done" };
  return Stream.unfold<PollState, Message | undefined, never, ApiClient>(
    { step: "first" },
    Effect.fnUntraced(function* (state) {
      if (state.step === "done") return undefined;
      const deadline =
        state.step === "first"
          ? (yield* Clock.currentTimeMillis) + (agent ? 30 * 60_000 : 180_000)
          : state.deadline;
      if (state.step === "next")
        yield* Effect.sleep(agent ? "5 seconds" : "1 second");
      const polled = yield* read;
      const done = { step: "done" } as const;
      if (Result.isFailure(polled)) {
        const error = polled.failure;
        return [
          typeof error !== "string"
            ? complete({ state: "failed", error })
            : pause(error),
          done,
        ] as const;
      }
      const data = polled.success;
      if (data.state === "cancelled")
        return [complete({ state: "cancelled" }), done] as const;
      if (data.state === "failed") {
        return [
          complete({
            state: "failed",
            error: `Genie could not complete this question (${data.status}).`,
          }),
          done,
        ] as const;
      }
      if (data.state === "completed")
        return [complete({ state: "retrieving" }), done] as const;
      const now = yield* Clock.currentTimeMillis;
      const unresolvedSince =
        data.state === "unresolved"
          ? ((state.step === "next" ? state.unresolvedSince : undefined) ?? now)
          : undefined;
      if (
        unresolvedSince !== undefined &&
        now - unresolvedSince >= agentVisibilityGraceMs
      ) {
        return [
          pause(
            "Genie could not locate this response. Resume waiting to check again.",
          ),
          done,
        ] as const;
      }
      if (now >= deadline) {
        return [
          pause(
            "Genie is taking longer than expected. Resume waiting for this answer.",
          ),
          done,
        ] as const;
      }
      const previous = state.step === "next" ? state.phase : undefined;
      const phase = agent && data.state === "pending" ? data.phase : undefined;
      return [
        phase !== undefined && phase !== previous
          ? complete({ state: "waiting", phase })
          : undefined,
        { step: "next", deadline, phase, unresolvedSince },
      ] as const;
    }),
  ).pipe(Stream.filter((message) => message !== undefined));
}

export const subscriptions = Subscription.make<Model, Message, ApiClient>()(
  (entry) => ({
    geniePoll: entry(PollSelection.fields, {
      modelToDependencies: (model) => ({
        generation: model.pollGeneration,
        waiting: model.turns.flatMap((turn) =>
          turn.state === "waiting"
            ? [{ id: turn.id, operation: turn.operation }]
            : [],
        ),
      }),
      // Each restored turn can finish while the others keep polling.
      keepAliveEquivalence: (left, right) =>
        left.generation === right.generation &&
        (left.waiting.length === 0) === (right.waiting.length === 0),
      dependenciesToStream: ({
        generation,
        waiting,
      }: typeof PollSelection.Type) =>
        Stream.mergeAll(
          waiting.map((turn) => poll(turn, generation)),
          {
            concurrency: "unbounded",
          },
        ),
    }),
  }),
);
