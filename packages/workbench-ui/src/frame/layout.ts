import { Dialog, Tooltip } from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import { syncDialog } from "./sync-dialog.js";

export const Model = Schema.Struct({
  sidebar: Schema.Boolean,
  mobile: Schema.Boolean,
  mobileNavigation: Schema.Boolean,
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
  navigationDialog: Dialog.Model,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  Resized: { mobile: Schema.Boolean },
  ToggleSidebar: {},
  CloseNavigation: {},
  GotNavigationDialogMessage: { message: Dialog.Message },
  GotTooltipMessage: { id: Schema.String, message: Tooltip.Message },
  CompletedPersistSidebar: {},
});
export type Message = typeof Message.Type;

export const init = (): Model => ({
  sidebar: true,
  mobile: false,
  mobileNavigation: false,
  tooltips: {},
  navigationDialog: Dialog.init({
    id: "mobile-navigation",
    focusSelector: "a",
  }),
});

export const initTooltip = (id: string) =>
  Tooltip.init({ id: `sidebar-${id}` });

const PersistSidebar = Command.define("PersistSidebar", {
  args: { open: Schema.Boolean },
  messages: [Message.CompletedPersistSidebar],
  execute: ({ open }) =>
    Effect.sync(() => {
      document.cookie = `sidebar_state=${open}; path=/; max-age=604800; SameSite=Lax`;
      return Message.CompletedPersistSidebar();
    }),
});

export const restore = (
  model: Model,
  { sidebar, mobile }: Pick<Model, "sidebar" | "mobile">,
): Model =>
  modifyFields(model, { sidebar: () => sidebar, mobile: () => mobile });

export const closeNavigation = (model: Model, resetTooltips = false): Model =>
  resetTooltips
    ? modifyFields(model, {
        mobileNavigation: () => false,
        tooltips: () => ({}),
      })
    : model.mobileNavigation
      ? modifyFields(model, { mobileNavigation: () => false })
      : model;

const dialogMessage = (message: Dialog.Message) =>
  Message.GotNavigationDialogMessage({ message });

const updateDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.navigationDialog),
  write: (model, dialog) =>
    modifyFields(model, { navigationDialog: () => dialog }),
  toParentMessage: dialogMessage,
  foldOutMessage: (out) => (model) => ({
    model: out._tag === "Closed" ? closeNavigation(model) : model,
  }),
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    Resized: ({ mobile }) => ({
      model: closeNavigation(
        modifyFields(model, { mobile: () => mobile }),
        true,
      ),
    }),
    ToggleSidebar: () =>
      model.mobile
        ? { model: modifyFields(model, { mobileNavigation: (open) => !open }) }
        : {
            model: modifyFields(model, {
              sidebar: (open) => !open,
              tooltips: () => ({}),
            }),
            commands: [PersistSidebar({ open: !model.sidebar })],
          },
    CloseNavigation: () => ({ model: closeNavigation(model) }),
    GotNavigationDialogMessage: ({ message }) => updateDialog(model, message),
    GotTooltipMessage: ({ id, message }) =>
      Update.foldChild({
        update: Tooltip.update,
        read: (parent: Model) =>
          Option.some(parent.tooltips[id] ?? initTooltip(id)),
        write: (parent, tooltip) =>
          modifyFields(parent, {
            tooltips: (tooltips) => ({ ...tooltips, [id]: tooltip }),
          }),
        toParentMessage: (message) =>
          Message.GotTooltipMessage({ id, message }),
        foldOutMessage: () => (model) => ({ model }),
      })(model, message),
    CompletedPersistSidebar: () => ({ model }),
  });

export function syncNavigationDialog(
  model: Model,
): Update.Return<Model, Message> {
  const dialog = syncDialog(
    model.navigationDialog,
    model.mobile && model.mobileNavigation,
  );
  return {
    model:
      dialog.model === model.navigationDialog
        ? model
        : modifyFields(model, { navigationDialog: () => dialog.model }),
    commands: (dialog.commands ?? []).map((command) =>
      Command.mapMessage(command, dialogMessage),
    ),
  };
}
