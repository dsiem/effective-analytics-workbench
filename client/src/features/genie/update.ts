import { Dialog } from "@foldkit/ui";
import { Option, Record } from "effect";
import { Command } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { GenieContext, GenieMode } from "@dsiem/analytics-shared/genie";
import type { Filters } from "@dsiem/analytics-shared/filters";
import type { ApiClient } from "../../lib/api-client";
import { syncDialog } from "../../lib/dialog";
import type { FeatureUpdate } from "../../lib/feature-update";
import * as GenieCommands from "./commands";
import { Message as M, type Message } from "./messages";
import {
  busy,
  stoppableOperation,
  type Model,
  type Turn,
  turnBase,
} from "./model";
export function updateGenie(
  model: Model,
  message: Message,
  context: Context,
): FeatureUpdate<Model, Message, Out> {
  return M.match<FeatureUpdate<Model, Message, Out>>(message, {
    MountedPanelReturnFocus: () => ({ model }),
    RestoredConversation: (message) => ({
      model: modifyFields(model, {
        turns: () => message.turns,
        genieMode: () => message.turns.at(-1)?.mode ?? "chat",
        lastPollGeneration: (generation) => generation + 1,
        pollGenerations: () =>
          Object.fromEntries(
            message.turns
              .filter((turn) => turn.state === "waiting")
              .map(({ id }) => [id, model.lastPollGeneration + 1]),
          ),
        persistenceError: () => message.persistenceError,
      }),
      commands: message.turns.flatMap((turn) =>
        turn.state === "retrieving"
          ? [GenieCommands.RetrieveQuestion({ turn })]
          : [],
      ),
    }),
    CloseGenie: () => ({
      model: modifyFields(model, { genieOpen: () => false }),
    }),
    GotGenieDialogMessage: (message) => {
      const changed = Dialog.update(model.helperDialog, message.message);
      return {
        model: modifyFields(model, {
          helperDialog: () => changed.model,
          genieOpen: (open) =>
            changed.outMessage?._tag === "Closed" ? false : open,
        }),
        commands: (changed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) =>
            M.GotGenieDialogMessage({ message }),
          ),
        ),
      };
    },
    OpenGenie: (message) => ({
      model: modifyFields(model, {
        genieOpen: () => true,
        genieSelection: (selection) =>
          message.context === null ? selection : Option.some(message.context),
        genieDraft: (draft) => message.question ?? draft,
      }),
      outMessage: { _tag: "Opened" },
    }),
    ExpandGenie: () => ({
      model: modifyFields(model, { genieExpanded: (expanded) => !expanded }),
    }),
    ClearSelection: () => clearSelection(model),
    GenieDraft: (message) => ({
      model: modifyFields(model, { genieDraft: () => message.value }),
    }),
    SetGenieMode: (message) => ({
      model: modifyFields(model, { genieMode: () => message.mode }),
    }),
    SubmittedQuestion: () => submitQuestion(model, model.genieDraft, context),
    SendQuestion: ({ question }) => submitQuestion(model, question, context),
    CreatedTurn: (message) => {
      if (busy(model)) return { model };
      const turn = {
        id: message.id,
        question: message.question,
        filters: message.filters,
        context: message.context,
        ...(message.mode ? { mode: message.mode } : {}),
        state: "submitting" as const,
      };
      const turns = [...model.turns, turn];
      return {
        model: modifyFields(model, {
          turns: () => turns,
          genieDraft: () => "",
        }),
        commands: [
          GenieCommands.PersistConversation({ turns }),
          GenieCommands.SubmitQuestion({
            turn,
            conversation: conversationFor(model.turns, turn.mode ?? "chat"),
          }),
        ],
      };
    },
    ChangedTurn: (message) => {
      const current = model.turns.find((turn) => turn.id === message.turn.id);
      return current ? changeTurn(model, current, message.turn) : { model };
    },
    PolledQuestion: (message) => {
      const turn = model.turns.find(({ id }) => id === message.id);
      if (
        message.generation !== model.pollGenerations[message.id] ||
        turn?.state !== "waiting" ||
        turn.operation.conversationId !== message.operation.conversationId ||
        turn.operation.messageId !== message.operation.messageId
      ) {
        return { model };
      }
      const { outcome } = message;
      if (outcome.state === "waiting") {
        return {
          model: modifyFields(model, {
            turns: (turns) =>
              turns.map((current) =>
                current.id === turn.id
                  ? { ...turn, phase: outcome.phase }
                  : current,
              ),
          }),
        };
      }
      return changeTurn(model, turn, {
        ...turnBase(turn),
        operation: turn.operation,
        ...message.outcome,
      });
    },
    StopTurn: (message) => {
      const turn = model.turns.find(({ id }) => id === message.id);
      const operation = turn && stoppableOperation(turn);
      if (!turn || !operation) return { model };
      const stopping = {
        ...turnBase(turn),
        operation,
        state: "stopping" as const,
      };
      const changed = changeTurn(model, turn, stopping);
      return {
        ...changed,
        commands: [
          ...(changed.commands ?? []),
          GenieCommands.StopQuestion({ turn: stopping }),
        ],
      };
    },
    ResumeTurn: (message) => {
      if (busy(model)) return { model };
      const turn = model.turns.find(({ id }) => id === message.id);
      return turn?.state === "paused"
        ? changeTurn(model, turn, {
            ...turnBase(turn),
            operation: turn.operation,
            state: turn.stage,
          })
        : { model };
    },
    RetryInChat: (message) => {
      if (busy(model)) return { model };
      const original = model.turns.find(({ id }) => id === message.id);
      if (original?.state !== "agent-mode-unavailable") return { model };
      const turn = {
        ...turnBase(original),
        mode: "chat" as const,
        state: "submitting" as const,
      };
      const turns = [
        ...model.turns.filter(({ id }) => id !== original.id),
        turn,
      ];
      return {
        model: modifyFields(model, {
          turns: () => turns,
          genieMode: () => "chat",
        }),
        commands: [
          GenieCommands.PersistConversation({ turns }),
          GenieCommands.SubmitQuestion({
            turn,
            conversation: conversationFor(model.turns, "chat"),
          }),
        ],
      };
    },
    EditQuestion: (message) => ({
      model: modifyFields(model, { genieDraft: () => message.question }),
      outMessage: { _tag: "FocusComposer" },
    }),
    NewConversation: () =>
      busy(model)
        ? { model }
        : {
            model: modifyFields(model, { turns: () => [] }),
            commands: [GenieCommands.PersistConversation({ turns: [] })],
          },
    Persisted: (message) => ({
      model: modifyFields(model, { persistenceError: () => message.error }),
    }),
    CopySql: (message) => ({
      model,
      commands: [GenieCommands.CopySql({ sql: message.sql })],
    }),
    CopiedSql: (message) => ({
      model: modifyFields(model, { clipboard: () => message.text }),
    }),
  });
}

function submitQuestion(
  model: Model,
  draft: string,
  { filters, context }: Context,
): FeatureUpdate<Model, Message> {
  const question = draft.trim();
  if (busy(model) || !question || !filters) return { model };
  return {
    model,
    commands: [
      GenieCommands.CreateQuestion({
        question,
        filters,
        context: Option.getOrElse(model.genieSelection, () => context),
        ...(model.genieMode === "agent" ? { mode: "agent" } : {}),
      }),
    ],
  };
}

export function clearSelection(model: Model): FeatureUpdate<Model, Message> {
  return {
    model: Option.isNone(model.genieSelection)
      ? model
      : modifyFields(model, { genieSelection: () => Option.none() }),
  };
}

function conversationFor(turns: ReadonlyArray<Turn>, mode: GenieMode) {
  const previous = turns.findLast(
    (prior) =>
      ("operation" in prior || prior.state === "complete") &&
      (prior.mode ?? "chat") === mode,
  );
  return previous && "operation" in previous
    ? previous.operation
    : previous?.state === "complete"
      ? {
          conversationId: previous.reply.conversationId,
          messageId: previous.reply.messageId,
          ...(previous.reply.mode ? { mode: previous.reply.mode } : {}),
          ...(previous.reply.grant ? { grant: previous.reply.grant } : {}),
        }
      : null;
}

function changeTurn(
  model: Model,
  current: Turn,
  next: Turn,
): FeatureUpdate<Model, Message> {
  const turns = model.turns.map((turn) => (turn.id === next.id ? next : turn));
  const commands: Command.Command<Message, never, ApiClient>[] = [
    GenieCommands.PersistConversation({ turns }),
  ];
  if (next.state === "retrieving" && current.state !== "retrieving")
    commands.push(GenieCommands.RetrieveQuestion({ turn: next }));
  const startsPolling = next.state === "waiting" && current.state !== "waiting";
  const generation = startsPolling
    ? model.lastPollGeneration + 1
    : model.lastPollGeneration;
  return {
    model: modifyFields(model, {
      turns: () => turns,
      lastPollGeneration: () => generation,
      pollGenerations: (polls) =>
        startsPolling
          ? { ...polls, [next.id]: generation }
          : next.state === "waiting"
            ? polls
            : Record.remove(polls, next.id),
    }),
    commands,
  };
}

export type Context = {
  readonly filters: Filters | null;
  readonly context: GenieContext;
};
export type Out =
  | { readonly _tag: "Opened" }
  | { readonly _tag: "FocusComposer" };

/** The shell supplies presentation context; the feature owns the modal lifecycle. */
export function presentGenie(
  model: Model,
  modal: boolean,
): FeatureUpdate<Model, Message> {
  const dialog = syncDialog(model.helperDialog, modal && model.genieOpen);
  return {
    model:
      dialog.model === model.helperDialog
        ? model
        : modifyFields(model, { helperDialog: () => dialog.model }),
    commands: (dialog.commands ?? []).map((command) =>
      Command.mapMessage(command, (message) =>
        M.GotGenieDialogMessage({ message }),
      ),
    ),
  };
}
