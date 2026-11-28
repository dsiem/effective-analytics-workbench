import { type Filters, sameFilters } from "@dsiem/analytics-shared/filters";
import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { Command } from "foldkit";
import { modifyFields } from "foldkit/struct";
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
import {
  type BrowserMessage,
  findingWrite,
  Message as M,
  type Message,
} from "./messages";
import type { Model } from "./model";
import { writes } from "./workflow";

type DialogId = keyof Model["dialogs"];

function mapDialogCommands(
  id: DialogId,
  commands: readonly Command.Command<Dialog.Message>[] = [],
): Command.Command<Message>[] {
  return commands.map((command) =>
    id === "savedView"
      ? Command.mapMessage(command, (message) =>
          M.GotSavedViewDialogMessage({ message }),
        )
      : Command.mapMessage(command, (message) =>
          M.GotDeleteDialogMessage({ message }),
        ),
  );
}

function withBrowser(
  model: Model,
  changed: FeatureUpdate<Browser.Model, Message>,
): FeatureUpdate<Model, Message> {
  return {
    model:
      changed.model === model.browser
        ? model
        : modifyFields(model, { browser: () => changed.model }),
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

function updateDialog(
  model: Model,
  id: DialogId,
  message: Dialog.Message,
): FeatureUpdate<Model, Message> {
  const panel = model.writes.panel;
  const busy =
    id === "savedView"
      ? panel._tag === "Editor" && panel.editor.saving
      : panel._tag === "Delete" && panel.busy;
  if (busy && message._tag === "RequestedClose") return { model };

  const changed = Dialog.update(model.dialogs[id], message);
  const commands = mapDialogCommands(id, changed.commands);
  if (
    id === "delete" &&
    message._tag === "CompletedCloseDialog" &&
    model.browser.picker.isOpen
  ) {
    commands.push(SavedViewsCommands.FocusSavedViewSearch());
  }
  const next = { ...model, dialogs: { ...model.dialogs, [id]: changed.model } };
  if (
    changed.outMessage?._tag !== "Closed" ||
    panel._tag !== (id === "savedView" ? "Editor" : "Delete")
  )
    return { model: next, commands };
  const canceled = writes.update(model.writes, writes.Message.Cancel());
  return { model: { ...next, writes: canceled.model }, commands };
}

function updateWrites(
  model: Model,
  message: typeof writes.Message.Type,
  context: Context,
): FeatureUpdate<Model, Message> {
  const changed = writes.update(model.writes, message);
  const next =
    changed.model === model.writes
      ? model
      : { ...model, writes: changed.model };
  const commands = Command.mapMessages(changed.commands, findingWrite);
  const result = changed.outMessage;
  if (!result) return { model: next, commands };

  const removedId = result._tag === "Deleted" ? result.id : null;
  const saved = result._tag === "Saved" ? result.row : null;
  const refreshed = withBrowser(
    {
      ...next,
      selection:
        saved && sameFilters(saved.filters, context.filters)
          ? Option.some({
              id: saved.id,
              title: saved.title,
              filters: saved.filters,
            })
          : Option.filter(next.selection, ({ id }) => id !== removedId),
      notice: saved ? `Saved “${saved.title}”` : removedId ? "" : next.notice,
    },
    refreshBrowser(next.browser, removedId),
  );
  const focusSearch =
    result._tag === "Pinned" ||
    (result._tag === "WriteFailed" && result.action === "Pin");
  return {
    ...refreshed,
    commands: [
      ...commands,
      ...(refreshed.commands ?? []),
      ...(focusSearch && next.browser.picker.isOpen
        ? [SavedViewsCommands.FocusSavedViewSearch()]
        : []),
    ],
  };
}

function updateSavedViewsState(
  model: Model,
  message: Message,
  context: Context,
): FeatureUpdate<Model, Message, Out> {
  const browser = (message: BrowserMessage) =>
    withBrowser(model, updateBrowser(model.browser, message));

  return M.match<FeatureUpdate<Model, Message, Out>>(message, {
    GotSavedViewDialogMessage: ({ message }) =>
      updateDialog(model, "savedView", message),
    GotDeleteDialogMessage: ({ message }) =>
      updateDialog(model, "delete", message),
    NewSavedView: () =>
      updateWrites(
        model,
        writes.Message.New({ input: context.filters }),
        context,
      ),
    GotFindingWriteMessage: ({ message }) =>
      updateWrites(model, message, context),
    RestoreView: ({ savedView: { id, title, filters } }) => {
      const changed = withBrowser(
        modifyFields(model, {
          selection: () => Option.some({ id, title, filters }),
          notice: () => "",
        }),
        selectBrowser(model.browser, id),
      );
      return {
        ...changed,
        outMessage: { _tag: "RestoreFilters", filters },
      };
    },
    ClearView: () => ({
      ...withBrowser(
        modifyFields(model, { selection: Option.none, notice: () => "" }),
        clearBrowser(model.browser),
      ),
      outMessage: { _tag: "RestoreFilters", filters: {} },
    }),
    GotSavedViewsPickerMessage: browser,
    MovedSavedViewPickerFocus: browser,
    SavedViewSearchChanged: browser,
    BrowseSavedViews: browser,
    ShowSavedViewShortcuts: browser,
    LoadSavedViewShortcuts: browser,
    LoadedSavedViewShortcuts: browser,
    CompletedPersistRecentSavedViews: browser,
    CompletedRememberRecentSavedView: browser,
    CompletedFocusSavedViewSearch: browser,
    GotFindingSearchMessage: browser,
  });
}

export type Context = { readonly filters: Filters };

export const clearNotice = (model: Model): Model =>
  model.notice ? modifyFields(model, { notice: () => "" }) : model;

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
  const {
    dialogs,
    writes: { panel },
  } = result.model;
  const savedView = syncDialog(dialogs.savedView, panel._tag === "Editor");
  const deletion = syncDialog(dialogs.delete, panel._tag === "Delete");
  return {
    ...result,
    model:
      savedView.model === dialogs.savedView && deletion.model === dialogs.delete
        ? result.model
        : modifyFields(result.model, {
            dialogs: () => ({
              savedView: savedView.model,
              delete: deletion.model,
            }),
          }),
    commands: [
      ...(result.commands ?? []),
      ...mapDialogCommands("savedView", savedView.commands),
      ...mapDialogCommands("delete", deletion.commands),
    ],
  };
}
