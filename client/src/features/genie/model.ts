import { Notice } from "../../lib/request-state";
import { Dialog } from "@foldkit/ui";
import { Schema } from "effect";
import {
  GenieAgentPhase,
  GenieContext,
  GenieMode,
  GenieModeQuery,
  GenieOperation,
  GenieReply,
} from "../../../../shared/genie";
import { Filters } from "../../../../shared/filters";
export const TurnBase = {
  id: Schema.String,
  question: Schema.String,
  filters: Schema.optionalKey(Filters),
  context: Schema.optionalKey(GenieContext),
  ...GenieModeQuery.fields,
};
export const StoppingTurn = Schema.Struct({
  ...TurnBase,
  state: Schema.Literal("stopping"),
  operation: GenieOperation,
});
export const Turn = Schema.Union([
  StoppingTurn,
  Schema.Struct({
    ...TurnBase,
    state: Schema.Literal("cancelled"),
    operation: GenieOperation,
  }),
  Schema.Struct({ ...TurnBase, state: Schema.Literal("submitting") }),
  Schema.Struct({
    ...TurnBase,
    state: Schema.Literals([
      "submission-rejected",
      "submission-unknown",
      "agent-mode-unavailable",
    ]),
    error: Notice,
  }),
  Schema.Struct({
    ...TurnBase,
    state: Schema.Literals(["waiting", "retrieving"]),
    phase: Schema.optionalKey(GenieAgentPhase),
    operation: GenieOperation,
  }),
  Schema.Struct({
    ...TurnBase,
    state: Schema.Literal("paused"),
    operation: GenieOperation,
    stage: Schema.Literals(["waiting", "retrieving"]),
    error: Notice,
  }),
  Schema.Struct({
    ...TurnBase,
    state: Schema.Literal("failed"),
    operation: GenieOperation,
    error: Notice,
  }),
  Schema.Struct({
    ...TurnBase,
    state: Schema.Literal("complete"),
    reply: GenieReply,
  }),
]);
export type Turn = typeof Turn.Type;
export const turnBase = ({ id, question, filters, context, mode }: Turn) => ({
  id,
  question,
  ...(filters ? { filters } : {}),
  ...(context ? { context } : {}),
  ...(mode ? { mode } : {}),
});
export const History = Schema.Array(Turn);
export const Model = Schema.Struct({
  helperDialog: Dialog.Model,
  genieOpen: Schema.Boolean,
  genieExpanded: Schema.Boolean,
  genieDraft: Schema.String,
  genieMode: GenieMode,
  genieSelection: Schema.NullOr(GenieContext),
  turns: History,
  pollGeneration: Schema.Int,
  persistenceError: Schema.String,
  clipboard: Schema.String,
});

export type Model = typeof Model.Type;

export const busy = (model: Model) =>
  model.turns.some((turn) =>
    ["submitting", "waiting", "stopping", "retrieving"].includes(turn.state),
  );

export const stoppableOperation = (turn: Turn) =>
  (turn.state === "waiting" ||
    (turn.state === "paused" && turn.stage === "waiting")) &&
  turn.operation.mode === "agent"
    ? turn.operation
    : undefined;

export const init = (): Model => ({
  helperDialog: Dialog.init({
    id: "genie-helper",
    focusSelector: "#genie-composer",
  }),
  genieOpen: false,
  genieExpanded: false,
  genieDraft: "",
  genieMode: "chat",
  genieSelection: null,
  turns: [],
  pollGeneration: 0,
  persistenceError: "",
  clipboard: "",
});
