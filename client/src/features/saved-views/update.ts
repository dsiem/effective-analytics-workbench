import { Dialog } from "@foldkit/ui";
import { Command } from "foldkit";
import { type Filters, sameFilters } from "@dsiem/analytics-shared/filters";
import { syncDialog } from "../../lib/dialog";
import type { FeatureUpdate } from "../../lib/feature-update";
import type * as Browser from "./browser-model";
import {
  clearBrowser,
  refreshBrowser,
  selectBrowser,
  updateBrowser,
} from "./browser-update";
import * as SavedViewsCommands from "./commands";
import { Message as M, type Message } from "./messages";
import type { Model } from "./model";

function withBrowser(
  model: Model,
  changed: FeatureUpdate<Browser.Model, Message>,
): FeatureUpdate<Model, Message> {
  return {
    model:
      changed.model === model.browser
        ? model
        : { ...model, browser: changed.model },
    commands: changed.commands ?? [],
  };
}

export function closeSavedViewsPicker(
  model: Model,
): FeatureUpdate<Model, Message> {
  return model.browser.picker.isOpen
    ? withBrowser(model, clearBrowser(model.browser))
    : { model };
}

function updateSavedViewsState(
  model: Model,
  message: Message,
  context: Context,
): FeatureUpdate<Model, Message, Out> {
  switch (message._tag) {
    case "Idle":
      return { model };
    case "CloseSavedView":
      return model.editor?.saving
        ? { model }
        : { model: { ...model, editor: null } };
    case "CloseDelete":
      return model.savedViewBusy
        ? { model }
        : { model: { ...model, deleting: null } };
    case "SavedViewDialog":
    case "DeleteDialog": {
      const id = message._tag === "SavedViewDialog" ? "savedView" : "delete";
      const busy =
        id === "savedView" ? model.editor?.saving : model.savedViewBusy;
      if (busy && message.message._tag === "RequestedClose") return { model };
      const changed = Dialog.update(model.dialogs[id], message.message);
      const commands: Command.Command<Message>[] = (changed.commands ?? []).map(
        (command) =>
          Command.mapMessage(command, (message) =>
            id === "savedView"
              ? M.SavedViewDialog({ message })
              : M.DeleteDialog({ message }),
          ),
      );
      if (
        id === "delete" &&
        message.message._tag === "CompletedCloseDialog" &&
        model.browser.picker.isOpen
      )
        commands.push(SavedViewsCommands.FocusSavedViewSearch());
      return {
        model: {
          ...model,
          dialogs: { ...model.dialogs, [id]: changed.model },
          ...(changed.outMessage?._tag === "Closed"
            ? id === "savedView"
              ? { editor: null }
              : { deleting: null }
            : {}),
        },
        commands,
      };
    }
    case "NewSavedView":
      return { model, commands: [SavedViewsCommands.NewSavedView({})] };
    case "CreatedSavedView":
      return {
        model: {
          ...model,
          editor: {
            draft: {
              id: message.id,
              title: "",
              body: "",
              filters: context.filters,
              version: null,
            },
            saving: false,
            error: "",
          },
        },
      };
    case "EditSavedView": {
      const { id, title, body, filters, version } = message.savedView;
      return {
        model: {
          ...model,
          editor: {
            draft: { id, title, body, filters, version },
            saving: false,
            error: "",
          },
        },
      };
    }
    case "SavedViewChanged":
      return {
        model: {
          ...model,
          editor: model.editor
            ? {
                ...model.editor,
                draft: {
                  ...model.editor.draft,
                  [message.field]: message.value,
                },
              }
            : null,
        },
      };
    case "SaveSavedView":
      return !model.editor ||
        model.editor.saving ||
        !model.editor.draft.title.trim()
        ? { model }
        : {
            model: {
              ...model,
              editor: { ...model.editor, saving: true, error: "" },
            },
            commands: [
              SavedViewsCommands.SaveSavedView({ draft: model.editor.draft }),
            ],
          };
    case "SavedViewSaved": {
      const next = {
        ...model,
        editor: message.savedView
          ? null
          : model.editor
            ? { ...model.editor, saving: false, error: message.error }
            : null,
        selection:
          message.savedView &&
          sameFilters(message.savedView.filters, context.filters)
            ? {
                id: message.savedView.id,
                title: message.savedView.title,
                filters: message.savedView.filters,
              }
            : model.selection,
        notice: message.savedView
          ? `Saved “${message.savedView.title}”`
          : model.notice,
      };
      return withBrowser(next, refreshBrowser(next.browser));
    }
    case "PinSavedView":
      return model.savedViewBusy
        ? { model }
        : {
            model: { ...model, savedViewBusy: true, savedViewError: "" },
            commands: [
              SavedViewsCommands.PinSavedView({ savedView: message.savedView }),
            ],
          };
    case "DeleteSavedView":
      return {
        model: { ...model, deleting: message.savedView, savedViewError: "" },
      };
    case "ConfirmDelete":
      return !model.deleting || model.savedViewBusy
        ? { model }
        : {
            model: { ...model, savedViewBusy: true },
            commands: [
              SavedViewsCommands.DeleteSavedView({ savedView: model.deleting }),
            ],
          };
    case "MutatedSavedView": {
      const removedId =
        message.removed && !message.error ? (model.deleting?.id ?? null) : null;
      const next = {
        ...model,
        savedViewBusy: false,
        savedViewError: message.error,
        notice: message.removed && !message.error ? "" : model.notice,
        deleting: message.removed && !message.error ? null : model.deleting,
        selection:
          message.removed &&
          !message.error &&
          model.deleting?.id === model.selection?.id
            ? null
            : model.selection,
      };
      const refreshed = withBrowser(
        next,
        refreshBrowser(next.browser, removedId),
      );
      return {
        ...refreshed,
        commands: [
          ...(refreshed.commands ?? []),
          ...(!model.deleting && model.browser.picker.isOpen
            ? [SavedViewsCommands.FocusSavedViewSearch()]
            : []),
        ],
      };
    }
    case "RestoreView": {
      const changed = withBrowser(
        {
          ...model,
          selection: {
            id: message.savedView.id,
            title: message.savedView.title,
            filters: message.savedView.filters,
          },
          notice: "",
        },
        selectBrowser(model.browser, message.savedView.id),
      );
      return {
        ...changed,
        outMessage: {
          _tag: "RestoreFilters",
          filters: message.savedView.filters,
        },
      };
    }
    case "ClearView":
      return {
        ...withBrowser(
          { ...model, selection: null, notice: "" },
          clearBrowser(model.browser),
        ),
        outMessage: { _tag: "RestoreFilters", filters: {} },
      };
    case "SavedViewsPicker":
    case "SavedViewSearchChanged":
    case "BrowseSavedViews":
    case "ShowSavedViewShortcuts":
    case "LoadSavedViewShortcuts":
    case "LoadedSavedViewShortcuts":
    case "CompletedCancelLoadSavedViews":
    case "LoadSavedViews":
    case "LoadedSavedViews":
      return withBrowser(model, updateBrowser(model.browser, message));
  }
}

export type Context = { readonly filters: Filters };
export type Out = {
  readonly _tag: "RestoreFilters";
  readonly filters: Filters;
};

export function updateSavedViews(
  model: Model,
  message: Message,
  context: Context,
): FeatureUpdate<Model, Message, Out> {
  const result = updateSavedViewsState(model, message, context);
  const savedView = syncDialog(
    result.model.dialogs.savedView,
    result.model.editor !== null,
  );
  const deletion = syncDialog(
    result.model.dialogs.delete,
    result.model.deleting !== null,
  );
  return {
    ...result,
    model:
      savedView.model === result.model.dialogs.savedView &&
      deletion.model === result.model.dialogs.delete
        ? result.model
        : {
            ...result.model,
            dialogs: { savedView: savedView.model, delete: deletion.model },
          },
    commands: [
      ...(result.commands ?? []),
      ...(savedView.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) =>
          M.SavedViewDialog({ message }),
        ),
      ),
      ...(deletion.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) => M.DeleteDialog({ message })),
      ),
    ],
  };
}
