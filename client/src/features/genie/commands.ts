import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { ApiError, genieAccessHeaders } from "@dsiem/analytics-shared/api";
import {
  GenieOperation,
  genieResultTimeoutMs,
} from "@dsiem/analytics-shared/genie";
import { request } from "../../lib/api-client";
import { failure } from "../../lib/command-result";
import { Message as M, QuestionSnapshot } from "./messages";
import { History, StoppingTurn, Turn, turnBase } from "./model";
const genieStorageKey = "databricks-effect-app.genie.v1";

export const RestoreConversation = Command.define("RestoreConversation", {
  messages: [M.RestoredConversation],
  execute: Effect.sync(() => {
    let turns: typeof History.Type = [];
    let persistenceError = "";
    try {
      const stored = sessionStorage.getItem(genieStorageKey);
      if (stored)
        turns = Schema.decodeUnknownSync(History)(JSON.parse(stored)).map(
          (turn) =>
            turn.state === "submitting"
              ? {
                  ...turnBase(turn),
                  state: "submission-unknown" as const,
                  error:
                    "The submission response was lost. The question may have been accepted. Check Genie before submitting it again.",
                }
              : turn.state === "stopping"
                ? {
                    ...turnBase(turn),
                    operation: turn.operation,
                    state: "waiting" as const,
                  }
                : turn,
        );
    } catch {
      persistenceError =
        "Conversation recovery is unavailable in this browser session.";
    }
    return M.RestoredConversation({ turns, persistenceError });
  }),
});
export const CreateQuestion = Command.define("CreateQuestion", {
  args: QuestionSnapshot.fields,
  messages: [M.CreatedTurn],
  execute: (snapshot) =>
    Effect.sync(() => M.CreatedTurn({ ...snapshot, id: crypto.randomUUID() })),
});
export const SubmitQuestion = Command.define("SubmitQuestion", {
  args: { turn: Turn, conversation: Schema.NullOr(GenieOperation) },
  messages: [M.ChangedTurn],
  execute: ({ turn, conversation }) =>
    request((client) =>
      client.genie.submit({
        headers: genieAccessHeaders(conversation?.grant),
        payload: {
          content: turn.question,
          ...(turn.mode ? { mode: turn.mode } : {}),
          ...(turn.filters ? { filters: turn.filters } : {}),
          ...(turn.context && turn.context.page !== "trips"
            ? { context: turn.context }
            : {}),
          ...(conversation
            ? { conversationId: conversation.conversationId }
            : {}),
        },
      }),
    ).pipe(
      Effect.scoped,
      Effect.match({
        onSuccess: (operation) =>
          M.ChangedTurn({
            turn: { ...turnBase(turn), state: "waiting", operation },
          }),
        onFailure: (error) => {
          const problem = failure(error);
          const agentUnavailable =
            turn.mode === "agent" &&
            Schema.is(ApiError)(error) &&
            error.error.code === "genie_agent_mode_unavailable";
          const rejected =
            agentUnavailable ||
            (Schema.is(ApiError)(error) &&
              (error.error.code === "invalid_request" ||
                error.error.code === "permission_denied" ||
                ("upstreamStatus" in error.error &&
                  [400, 401, 403, 404, 409, 422, 429].includes(
                    error.error.upstreamStatus ?? 0,
                  ))));
          return M.ChangedTurn({
            turn: {
              ...turnBase(turn),
              state: agentUnavailable
                ? "agent-mode-unavailable"
                : rejected
                  ? "submission-rejected"
                  : "submission-unknown",
              error:
                typeof problem !== "string"
                  ? problem
                  : rejected
                    ? `The question was rejected. ${problem}`
                    : `${problem} The question may have been accepted. Check Genie before submitting it again.`,
            },
          });
        },
      }),
    ),
});
export const StopQuestion = Command.define("StopQuestion", {
  args: { turn: StoppingTurn },
  messages: [M.ChangedTurn],
  execute: ({ turn }) => {
    const { operation } = turn;
    const accepted = { ...turnBase(turn), operation };
    return request((client) =>
      client.genie.cancel({
        headers: genieAccessHeaders(operation.grant),
        params: {
          conversationId: operation.conversationId,
          responseId: operation.messageId,
        },
      }),
    ).pipe(
      Effect.scoped,
      Effect.mapError(failure),
      Effect.match({
        onSuccess: ({ state, status }) => {
          switch (state) {
            case "cancelled":
              return M.ChangedTurn({
                turn: { ...accepted, state: "cancelled" },
              });
            case "completed":
              return M.ChangedTurn({
                turn: { ...accepted, state: "retrieving" },
              });
            case "failed":
              return M.ChangedTurn({
                turn: {
                  ...accepted,
                  state: "failed",
                  error: `Genie could not complete this question (${status}).`,
                },
              });
            case "pending":
              return M.ChangedTurn({ turn: { ...accepted, state: "waiting" } });
          }
        },
        onFailure: (error) =>
          M.ChangedTurn({
            turn: {
              ...accepted,
              state: "paused",
              stage: "waiting",
              error:
                typeof error === "string"
                  ? "Stop could not be confirmed. Resume waiting to check the response."
                  : error,
            },
          }),
      }),
    );
  },
});

export const RetrieveQuestion = Command.define("RetrieveQuestion", {
  args: { turn: Turn },
  messages: [M.ChangedTurn],
  execute: ({ turn }) => {
    if (!("operation" in turn)) return Effect.succeed(M.ChangedTurn({ turn }));
    const operation = turn.operation;
    return request(
      (client) =>
        client.genie.result({
          headers: genieAccessHeaders(operation.grant),
          params: operation,
          query: operation.mode ? { mode: operation.mode } : {},
        }),
      genieResultTimeoutMs + 15_000,
    ).pipe(
      Effect.scoped,
      Effect.mapError(failure),
      Effect.match({
        onSuccess: (reply) =>
          M.ChangedTurn({
            turn: { ...turnBase(turn), state: "complete", reply },
          }),
        onFailure: (error) =>
          M.ChangedTurn({
            turn:
              typeof error !== "string"
                ? {
                    ...turnBase(turn),
                    operation,
                    error,
                    state: "failed",
                  }
                : {
                    ...turnBase(turn),
                    operation,
                    error,
                    state: "paused",
                    stage: "retrieving",
                  },
          }),
      }),
    );
  },
});
export const PersistConversation = Command.define("PersistConversation", {
  args: { turns: History },
  messages: [M.Persisted],
  execute: ({ turns }) =>
    Effect.sync(() => {
      try {
        sessionStorage.setItem(genieStorageKey, JSON.stringify(turns));
        return M.Persisted({ error: "" });
      } catch {
        return M.Persisted({
          error:
            "Conversation recovery could not be saved. Keep this tab open to retain the answer.",
        });
      }
    }),
});
export const CopySql = Command.define("CopySql", {
  args: { sql: Schema.String },
  messages: [M.CopiedSql],
  execute: ({ sql }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(sql)).pipe(
      Effect.match({
        onSuccess: () => M.CopiedSql({ text: "Copied" }),
        onFailure: () =>
          M.CopiedSql({
            text: "Unable to copy. Select the SQL above to copy it.",
          }),
      }),
    ),
});
