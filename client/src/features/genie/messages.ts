import { Notice } from "../../lib/request-state";
import { Dialog } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import {
  GenieAgentPhase,
  GenieContext,
  GenieMode,
  GenieModeQuery,
  GenieOperation,
} from "../../../../shared/genie";
import { Filters } from "../../../../shared/filters";
import { History, Turn } from "./model";

export const QuestionSnapshot = Schema.Struct({
  question: Schema.String,
  filters: Filters,
  context: GenieContext,
  ...GenieModeQuery.fields,
});

export const PollTarget = Schema.Struct({
  id: Schema.String,
  operation: GenieOperation,
});

const PollOutcome = Schema.Union([
  Schema.Struct({ state: Schema.Literal("waiting"), phase: GenieAgentPhase }),
  Schema.Struct({ state: Schema.Literal("retrieving") }),
  Schema.Struct({ state: Schema.Literal("cancelled") }),
  Schema.Struct({
    state: Schema.Literal("paused"),
    stage: Schema.Literal("waiting"),
    error: Notice,
  }),
  Schema.Struct({ state: Schema.Literal("failed"), error: Notice }),
]);

export const messages = {
  CloseGenie: {},
  GenieDialog: { message: Dialog.Message },
  RestoredConversation: { turns: History, persistenceError: Schema.String },
  OpenGenie: {
    context: Schema.NullOr(GenieContext),
    question: Schema.NullOr(Schema.String),
  },
  ExpandGenie: {},
  ClearSelection: {},
  GenieDraft: { value: Schema.String },
  SetGenieMode: { mode: GenieMode },
  SendQuestion: { question: Schema.String },
  CreatedTurn: { id: Schema.String, ...QuestionSnapshot.fields },
  ChangedTurn: { turn: Turn },
  PolledQuestion: {
    ...PollTarget.fields,
    generation: Schema.Int,
    outcome: PollOutcome,
  },
  ResumeTurn: { id: Schema.String },
  RetryInChat: { id: Schema.String },
  StopTurn: { id: Schema.String },
  EditQuestion: { question: Schema.String },
  NewConversation: {},
  Persisted: { error: Schema.String },
  CopySql: { sql: Schema.String },
  CopiedSql: { text: Schema.String },
};

export const Message = defineMessageUnion({ Idle: {}, ...messages });
export type Message = typeof Message.Type;
