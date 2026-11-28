import { Effect, Schema } from "effect";
import { Command, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { savedViewSchemas } from "@dsiem/analytics/contracts";
import { findingEditor } from "./editor.js";

import type { FindingOperations } from "./client.js";

/** Own a versioned draft, pin requests, and deletion confirmation. */
export function createFindingWrites<F, I, E, R = never>(
  options: Omit<FindingOperations<F, E, R>, "list"> & {
    readonly filters: Schema.Codec<F>;
    readonly error: Schema.Codec<E>;
    readonly newFinding: {
      readonly input: Schema.Codec<I>;
      readonly filters: (input: I) => Effect.Effect<F, E, R>;
    };
  },
) {
  const { SavedView: Row } = savedViewSchemas(options.filters);
  const Error = Schema.NullOr(options.error);
  const editor = findingEditor(options.filters, Error, null);
  const generation = Schema.Natural;
  const Panel = Schema.Union([
    Schema.TaggedStruct("Browse", { error: Error }),
    Schema.TaggedStruct("Preparing", {}),
    Schema.TaggedStruct("Editor", { editor: editor.Model }),
    Schema.TaggedStruct("Pinning", {}),
    Schema.TaggedStruct("Delete", {
      row: Row,
      busy: Schema.Boolean,
      error: Error,
    }),
  ]);
  const Model = Schema.Struct({ generation, panel: Panel });
  const Action = Schema.Union([
    Schema.TaggedStruct("Save", { draft: editor.Draft }),
    Schema.TaggedStruct("Pin", { row: Row }),
    Schema.TaggedStruct("Delete", { row: Row }),
  ]);
  const messageFields = {
    New: { input: options.newFinding.input },
    Copy: {},
    DraftPrepared: { generation, draft: editor.Draft },
    Edit: { row: Row },
    Change: { field: Schema.Literals(["body", "title"]), value: Schema.String },
    Cancel: {},
    Save: {},
    Pin: { row: Row },
    Delete: { row: Row },
    Confirm: {},
    Saved: { generation, row: Row },
    Pinned: { generation, pinned: Schema.Boolean },
    Deleted: { generation, id: Row.fields.id },
    WriteFailed: { generation, error: options.error },
  };
  const Message = defineMessageUnion(messageFields);
  type Model = typeof Model.Type;
  type Message = typeof Message.Type;
  type Panel = typeof Panel.Type;
  type Action = typeof Action.Type;
  type Out =
    | { readonly _tag: "Saved"; readonly row: typeof Row.Type }
    | { readonly _tag: "Pinned"; readonly pinned: boolean }
    | { readonly _tag: "Deleted"; readonly id: string }
    | { readonly _tag: "WriteFailed"; readonly action: Action["_tag"] };
  type Transition = Update.ReturnWithOutMessage<Model, Message, Out, R>;

  const prepare = Command.define("PrepareFindingDraft", {
    args: { input: options.newFinding.input, generation },
    messages: [Message.DraftPrepared, Message.WriteFailed],
    execute: ({ input, generation }) =>
      options.newFinding.filters(input).pipe(
        Effect.match({
          onSuccess: (filters) =>
            Message.DraftPrepared({
              generation,
              draft: {
                id: crypto.randomUUID(),
                title: "",
                body: "",
                filters,
                version: null,
              },
            }),
          onFailure: (error) => Message.WriteFailed({ generation, error }),
        }),
      ),
  });
  const copy = Command.define("CopyFindingDraft", {
    args: { draft: editor.Draft, generation },
    messages: [Message.DraftPrepared],
    execute: ({ draft, generation }) =>
      Effect.sync(() =>
        Message.DraftPrepared({
          generation,
          draft: { ...draft, id: crypto.randomUUID(), version: null },
        }),
      ),
  });
  const write = Command.define("WriteFinding", {
    args: { action: Action, generation },
    messages: [
      Message.Saved,
      Message.Pinned,
      Message.Deleted,
      Message.WriteFailed,
    ],
    execute: ({ action, generation }) => {
      const denied = (error: E) => Message.WriteFailed({ generation, error });
      switch (action._tag) {
        case "Save":
          return options
            .save({ ...action.draft, title: action.draft.title.trim() })
            .pipe(
              Effect.match({
                onSuccess: (row) => Message.Saved({ generation, row }),
                onFailure: denied,
              }),
            );
        case "Pin": {
          const { id, version, pinned } = action.row;
          return options.pin(id, !pinned, version).pipe(
            Effect.match({
              onSuccess: () => Message.Pinned({ generation, pinned: !pinned }),
              onFailure: denied,
            }),
          );
        }
        case "Delete": {
          const { id, version } = action.row;
          return options.remove(id, version).pipe(
            Effect.match({
              onSuccess: () => Message.Deleted({ generation, id }),
              onFailure: denied,
            }),
          );
        }
      }
    },
  });

  const browse = (error: E | null = null): Panel => ({ _tag: "Browse", error });
  const init = (): Model => ({ generation: 0, panel: browse() });

  function update(model: Model, message: Message): Transition {
    const { panel } = model;
    const nextGeneration = model.generation + 1;
    const run = (action: Action, next: Panel): Transition => ({
      model: { generation: nextGeneration, panel: next },
      commands: [write({ action, generation: nextGeneration })],
    });
    const settled = (next: Panel, outMessage: Out): Transition => ({
      model: { ...model, panel: next },
      outMessage,
    });
    if ("generation" in message && message.generation !== model.generation)
      return { model };
    switch (message._tag) {
      case "New":
        return panel._tag === "Browse"
          ? {
              model: {
                generation: nextGeneration,
                panel: { _tag: "Preparing" },
              },
              commands: [
                prepare({ input: message.input, generation: nextGeneration }),
              ],
            }
          : { model };
      case "Copy":
        return panel._tag === "Editor" &&
          !panel.editor.saving &&
          panel.editor.error !== null &&
          panel.editor.draft.version !== null
          ? {
              model: {
                generation: nextGeneration,
                panel: { ...panel, editor: { ...panel.editor, saving: true } },
              },
              commands: [
                copy({ draft: panel.editor.draft, generation: nextGeneration }),
              ],
            }
          : { model };
      case "DraftPrepared":
        return panel._tag === "Preparing" ||
          (panel._tag === "Editor" && panel.editor.saving)
          ? {
              model: {
                ...model,
                panel: { _tag: "Editor", editor: editor.edit(message.draft) },
              },
            }
          : { model };
      case "Edit":
        return panel._tag === "Browse"
          ? {
              model: {
                ...model,
                panel: { _tag: "Editor", editor: editor.edit(message.row) },
              },
            }
          : { model };
      case "Change":
        return panel._tag === "Editor" && !panel.editor.saving
          ? {
              model: {
                ...model,
                panel: {
                  ...panel,
                  editor: editor.change(
                    panel.editor,
                    message.field,
                    message.value,
                  ),
                },
              },
            }
          : { model };
      case "Cancel":
        return (panel._tag === "Editor" && !panel.editor.saving) ||
          (panel._tag === "Delete" && !panel.busy)
          ? { model: { ...model, panel: browse() } }
          : { model };
      case "Save": {
        const pending = panel._tag === "Editor" && editor.submit(panel.editor);
        return pending
          ? run(
              { _tag: "Save", draft: pending.draft },
              { _tag: "Editor", editor: pending },
            )
          : { model };
      }
      case "Pin":
        return panel._tag === "Browse"
          ? run({ _tag: "Pin", row: message.row }, { _tag: "Pinning" })
          : { model };
      case "Delete":
        return panel._tag === "Browse"
          ? {
              model: {
                ...model,
                panel: {
                  _tag: "Delete",
                  row: message.row,
                  busy: false,
                  error: null,
                },
              },
            }
          : { model };
      case "Confirm":
        return panel._tag === "Delete" && !panel.busy
          ? run(
              { _tag: "Delete", row: panel.row },
              { ...panel, busy: true, error: null },
            )
          : { model };
      case "Saved":
        return panel._tag === "Editor" && panel.editor.saving
          ? settled(browse(), { _tag: "Saved", row: message.row })
          : { model };
      case "Pinned":
        return panel._tag === "Pinning"
          ? settled(browse(), { _tag: "Pinned", pinned: message.pinned })
          : { model };
      case "Deleted":
        return panel._tag === "Delete" && panel.busy
          ? settled(browse(), { _tag: "Deleted", id: message.id })
          : { model };
      case "WriteFailed":
        if (panel._tag === "Editor" && panel.editor.saving)
          return settled(
            { ...panel, editor: editor.reject(panel.editor, message.error) },
            { _tag: "WriteFailed", action: "Save" },
          );
        if (panel._tag === "Delete" && panel.busy)
          return settled(
            { ...panel, busy: false, error: message.error },
            { _tag: "WriteFailed", action: "Delete" },
          );
        if (panel._tag === "Pinning")
          return settled(browse(message.error), {
            _tag: "WriteFailed",
            action: "Pin",
          });
        return panel._tag === "Preparing"
          ? { model: { ...model, panel: browse(message.error) } }
          : { model };
    }
  }
  return { Model, Message, messageFields, init, update };
}
