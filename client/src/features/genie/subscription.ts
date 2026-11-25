import {
  Clock,
  Context,
  Data,
  Effect,
  FiberMap,
  Layer,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import { genieAccessHeaders } from "@dsiem/analytics-shared/api";
import { Subscription } from "foldkit";
import type { GenieAgentPhase } from "@dsiem/analytics-shared/genie";
import { type ApiClient, request } from "../../lib/api-client";
import { failure } from "../../lib/command-result";
import { Message as M, type Message, PollTarget } from "./messages";
import type { Model } from "./model";

const agentVisibilityGraceMs = 30_000;
class PollDeadlineExceeded extends Data.TaggedError("PollDeadlineExceeded") {}
type PollMessage = ReturnType<typeof M.PolledQuestion>;

function poll(target: typeof PollTarget.Type) {
  const complete = (outcome: PollMessage["outcome"]) =>
    M.PolledQuestion({ ...target, outcome });
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
        readonly phase: GenieAgentPhase | undefined;
        readonly unresolvedSince: number | undefined;
      }
    | { readonly step: "done" };
  return Stream.unfold<PollState, PollMessage | undefined, never, ApiClient>(
    { step: "first" },
    Effect.fnUntraced(function* (state) {
      if (state.step === "done") return undefined;
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
      const previous = state.step === "next" ? state.phase : undefined;
      const phase = agent && data.state === "pending" ? data.phase : undefined;
      return [
        phase !== undefined && phase !== previous
          ? complete({ state: "waiting", phase })
          : undefined,
        { step: "next", phase, unresolvedSince },
      ] as const;
    }),
  ).pipe(
    Stream.filter((message) => message !== undefined),
    Stream.interruptWhen(
      Effect.sleep(agent ? "30 minutes" : "3 minutes").pipe(
        Effect.andThen(Effect.fail(new PollDeadlineExceeded())),
      ),
    ),
    Stream.catchTag("PollDeadlineExceeded", () =>
      Stream.succeed(
        pause(
          "Genie is taking longer than expected. Resume waiting for this answer.",
        ),
      ),
    ),
  );
}

const makeGeniePolling = Effect.gen(function* () {
  const fibers = yield* FiberMap.make<string, void, never>();
  const messages = yield* Queue.unbounded<PollMessage>();
  // Keep the selection after completion until its message reaches update.
  let active = new Map<string, number>();

  const sync = Effect.fnUntraced(function* (
    waiting: ReadonlyArray<typeof PollTarget.Type>,
  ) {
    const next = new Map(waiting.map(({ id, generation }) => [id, generation]));
    for (const [id, generation] of active) {
      if (next.get(id) !== generation) yield* FiberMap.remove(fibers, id);
    }
    for (const target of waiting) {
      if (active.get(target.id) !== target.generation) {
        yield* FiberMap.run(
          fibers,
          target.id,
          poll(target).pipe(
            Stream.runForEach((message) => Queue.offer(messages, message)),
            Effect.interruptible,
          ),
        );
      }
    }
    active = next;
  }, Effect.uninterruptible);
  return {
    sync,
    messages: Stream.merge(
      Stream.fromQueue(messages),
      Stream.fromEffect(FiberMap.join(fibers)).pipe(Stream.drain),
    ),
  };
});

export class GeniePolling extends Context.Service<
  GeniePolling,
  Effect.Success<typeof makeGeniePolling>
>()("app/GeniePolling") {
  static readonly layer = Layer.effect(this, makeGeniePolling);
}

export const subscriptions = Subscription.make<
  Model,
  Message,
  ApiClient | GeniePolling
>()((entry) => ({
  geniePoll: entry(
    { waiting: Schema.Array(PollTarget) },
    {
      modelToDependencies: (model) => ({
        waiting: model.turns.flatMap((turn) => {
          const generation = model.pollGenerations[turn.id];
          return turn.state === "waiting" && generation !== undefined
            ? [{ id: turn.id, operation: turn.operation, generation }]
            : [];
        }),
      }),
      dependenciesToStream: ({ waiting }) =>
        Stream.fromEffect(
          GeniePolling.use((polling) => polling.sync(waiting)),
        ).pipe(Stream.drain),
    },
  ),
  geniePollMessages: Subscription.persistentEntry(
    Stream.unwrap(
      GeniePolling.use((polling) => Effect.succeed(polling.messages)),
    ),
  ),
}));
