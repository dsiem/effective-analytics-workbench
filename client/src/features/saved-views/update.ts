import { type Filters, sameFilters } from "@dsiem/analytics-shared/filters";
import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { AsyncData, Command } from "foldkit";
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
import { type BrowserMessage, Message as M, type Message } from "./messages";
import type { Model } from "./model";

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
  const busy =
    id === "savedView"
      ? Option.exists(model.editor, (editor) => editor.saving)
      : model.savedViewBusy;
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
  const dialogs = { ...model.dialogs, [id]: changed.model };
  const next = modifyFields(model, { dialogs: () => dialogs });
  return {
    model:
      changed.outMessage?._tag === "Closed"
        ? id === "savedView"
          ? modifyFields(next, { editor: Option.none })
          : modifyFields(next, { deleting: Option.none })
        : next,
    commands,
  };
}

function updateSavedViewsState(
  model: Model,
  message: Message,
  context: Context,
): FeatureUpdate<Model, Message, Out> {
  const editor = Option.getOrUndefined(model.editor);
  const deleting = Option.getOrUndefined(model.deleting);
  const browser = (message: BrowserMessage) =>
    withBrowser(model, updateBrowser(model.browser, message));

  return M.match<FeatureUpdate<Model, Message, Out>>(message, {
    CloseSavedView: () => ({
      model: editor?.saving
        ? model
        : modifyFields(model, { editor: Option.none }),
    }),
    CloseDelete: () => ({
      model: model.savedViewBusy
        ? model
        : modifyFields(model, { deleting: Option.none }),
    }),
    GotSavedViewDialogMessage: ({ message }) =>
      updateDialog(model, "savedView", message),
    GotDeleteDialogMessage: ({ message }) =>
      updateDialog(model, "delete", message),
    NewSavedView: () => ({
      model,
      commands: [SavedViewsCommands.CreateSavedViewDraft({})],
    }),
    CreatedSavedView: ({ id }) => ({
      model: modifyFields(model, {
        editor: () =>
          Option.some({
            draft: {
              id,
              title: "",
              body: "",
              filters: context.filters,
              version: null,
            },
            saving: false,
            error: "",
          }),
      }),
    }),
    EditSavedView: ({ savedView: { id, title, body, filters, version } }) => ({
      model: modifyFields(model, {
        editor: () =>
          Option.some({
            draft: { id, title, body, filters, version },
            saving: false,
            error: "",
          }),
      }),
    }),
    SavedViewChanged: ({ field, value }) => ({
      model: modifyFields(model, {
        editor: Option.map((editor) => {
          const draft = { ...editor.draft, [field]: value };
          return modifyFields(editor, { draft: () => draft });
        }),
      }),
    }),
    SaveSavedView: () =>
      !editor || editor.saving || !editor.draft.title.trim()
        ? { model }
        : {
            model: modifyFields(model, {
              editor: () =>
                Option.some(
                  modifyFields(editor, { saving: () => true, error: () => "" }),
                ),
            }),
            commands: [
              SavedViewsCommands.SaveSavedView({ draft: editor.draft }),
            ],
          },
    SavedViewSaved: ({ result }) => {
      const savedView = Option.getOrUndefined(AsyncData.getData(result));
      const error = Option.getOrElse(AsyncData.getError(result), () => "");
      const next = modifyFields(model, {
        editor: (editor) =>
          savedView
            ? Option.none()
            : Option.map(editor, (current) =>
                modifyFields(current, {
                  saving: () => false,
                  error: () => error,
                }),
              ),
        selection: (selection) =>
          savedView && sameFilters(savedView.filters, context.filters)
            ? Option.some({
                id: savedView.id,
                title: savedView.title,
                filters: savedView.filters,
              })
            : selection,
        notice: (notice) => (savedView ? `Saved “${savedView.title}”` : notice),
      });
      return withBrowser(next, refreshBrowser(next.browser));
    },
    PinSavedView: ({ savedView }) =>
      model.savedViewBusy
        ? { model }
        : {
            model: modifyFields(model, {
              savedViewBusy: () => true,
              savedViewError: () => "",
            }),
            commands: [SavedViewsCommands.PinSavedView({ savedView })],
          },
    DeleteSavedView: ({ savedView }) => ({
      model: modifyFields(model, {
        deleting: () => Option.some(savedView),
        savedViewError: () => "",
      }),
    }),
    ConfirmDelete: () =>
      !deleting || model.savedViewBusy
        ? { model }
        : {
            model: modifyFields(model, { savedViewBusy: () => true }),
            commands: [
              SavedViewsCommands.DeleteSavedView({ savedView: deleting }),
            ],
          },
    MutatedSavedView: ({ result }) => {
      const deleted = result._tag === "Success" && result.data.removed;
      const error = Option.getOrElse(AsyncData.getError(result), () => "");
      const removedId = deleted ? deleting?.id : undefined;
      const next = modifyFields(model, {
        savedViewBusy: () => false,
        savedViewError: () => error,
        notice: (notice) => (deleted ? "" : notice),
        deleting: (deleting) => (deleted ? Option.none() : deleting),
        selection: Option.filter((selection) => selection.id !== removedId),
      });
      const refreshed = withBrowser(
        next,
        refreshBrowser(next.browser, removedId),
      );
      return {
        ...refreshed,
        commands: [
          ...(refreshed.commands ?? []),
          ...(!deleting && model.browser.picker.isOpen
            ? [SavedViewsCommands.FocusSavedViewSearch()]
            : []),
        ],
      };
    },
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
    CompletedCancelLoadSavedViews: browser,
    CompletedPersistRecentSavedViews: browser,
    CompletedRememberRecentSavedView: browser,
    CompletedFocusSavedViewSearch: browser,
    LoadSavedViews: browser,
    LoadedSavedViews: browser,
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
  const { dialogs, editor, deleting } = result.model;
  const savedView = syncDialog(dialogs.savedView, Option.isSome(editor));
  const deletion = syncDialog(dialogs.delete, Option.isSome(deleting));
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
