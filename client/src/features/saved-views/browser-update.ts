import { Popover } from "@foldkit/ui";
import { Option, Result } from "effect";
import { AsyncData, Command, type Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { FeatureUpdate } from "../../lib/feature-update";
import { fromResponse } from "../../lib/request-state";
import { type Model, PickerMode } from "./browser-model";
import * as SavedViewsCommands from "./commands";
import {
  BrowserMessage as M,
  type BrowserMessage,
  type Message,
} from "./messages";
import { mergeSavedViews, rememberRecent, searchText } from "./picker";

const loadedOrIdle = <A>(data: Option.Option<A>) =>
  Option.match(data, { onNone: AsyncData.Idle, onSome: AsyncData.succeed });

function foldPicker(
  model: Model,
  changed: Update.ReturnWithOutMessage<
    Popover.Model,
    Popover.Message,
    Popover.OutMessage
  >,
): FeatureUpdate<Model, Message> {
  return {
    model: modifyFields(model, { picker: () => changed.model }),
    commands: (changed.commands ?? []).map((command) =>
      Command.mapMessage(command, (message) =>
        M.GotSavedViewsPickerMessage({ message }),
      ),
    ),
  };
}

function loadSavedViews(
  model: Model,
  more = false,
  debounce = false,
): FeatureUpdate<Model, Message> {
  const version = model.searchVersion + 1;
  return {
    model: modifyFields(model, {
      searchVersion: () => version,
      savedViews: (savedViews) =>
        model.pickerMode._tag === "Quick"
          ? loadedOrIdle(AsyncData.getData(savedViews))
          : Option.getOrElse(
              AsyncData.revalidateOrLoad(savedViews),
              () => savedViews,
            ),
    }),
    commands: [
      SavedViewsCommands.LoadSavedViews.Interrupt(() =>
        M.CompletedCancelLoadSavedViews({ version, more, debounce }),
      ),
    ],
  };
}
function loadShortcuts(
  model: Model,
  removedId: string | null = null,
): FeatureUpdate<Model, Message> {
  const version = model.shortcutVersion + 1;
  return {
    model: modifyFields(model, {
      shortcutVersion: () => version,
      shortcuts: (shortcuts) =>
        Option.getOrElse(
          AsyncData.revalidateOrLoad(shortcuts),
          () => shortcuts,
        ),
    }),
    commands: [
      SavedViewsCommands.LoadSavedViewShortcuts({
        version,
        fallback: model.recentIds,
        removedId,
      }),
    ],
  };
}
function changeMode(model: Model, pickerMode: typeof PickerMode.Type) {
  return loadSavedViews(
    modifyFields(model, {
      pickerMode: () => pickerMode,
      savedViewPages: () => 1,
      savedViews: () => AsyncData.Idle(),
    }),
    false,
    pickerMode._tag === "Search",
  );
}
function invalidatePicker(model: Model) {
  return loadSavedViews(
    modifyFields(model, {
      pickerMode: () => PickerMode.Quick(),
      shortcutVersion: (version) => version + 1,
      shortcuts: (shortcuts) =>
        AsyncData.isPending(shortcuts)
          ? loadedOrIdle(AsyncData.getData(shortcuts))
          : shortcuts,
    }),
  );
}

function changeModeAndFocus(model: Model, pickerMode: typeof PickerMode.Type) {
  const changed = changeMode(model, pickerMode);
  return {
    ...changed,
    commands: [
      ...(changed.commands ?? []),
      SavedViewsCommands.FocusSavedViewSearch(),
    ],
  };
}

export function updateBrowser(
  model: Model,
  message: BrowserMessage,
): FeatureUpdate<Model, Message> {
  const unchanged = () => ({ model });
  return M.match<FeatureUpdate<Model, Message>>(message, {
    MovedSavedViewPickerFocus: unchanged,
    CompletedPersistRecentSavedViews: unchanged,
    CompletedRememberRecentSavedView: unchanged,
    CompletedFocusSavedViewSearch: unchanged,
    GotSavedViewsPickerMessage: (message) => {
      const changed = Popover.update(model.picker, message.message);
      const folded = foldPicker(model, changed);
      if (changed.outMessage?._tag === "Closed") {
        const invalidated = invalidatePicker(folded.model);
        return {
          ...invalidated,
          commands: [
            ...(folded.commands ?? []),
            ...(invalidated.commands ?? []),
          ],
        };
      }
      if (changed.outMessage?._tag !== "Opened") return folded;
      const loaded = loadShortcuts(
        modifyFields(folded.model, { pickerMode: () => PickerMode.Quick() }),
      );
      return {
        ...loaded,
        commands: [...(folded.commands ?? []), ...(loaded.commands ?? [])],
      };
    },
    SavedViewSearchChanged: (message) =>
      changeMode(
        model,
        message.value
          ? PickerMode.Search({ query: message.value.slice(0, 200) })
          : PickerMode.Quick(),
      ),
    BrowseSavedViews: () => changeModeAndFocus(model, PickerMode.Browse()),
    ShowSavedViewShortcuts: () => changeModeAndFocus(model, PickerMode.Quick()),
    LoadSavedViewShortcuts: () => loadShortcuts(model),
    LoadedSavedViewShortcuts: (message) => {
      if (message.version !== model.shortcutVersion || !model.picker.isOpen)
        return { model };
      return {
        model: modifyFields(model, {
          recentIds: (ids) => (message.data ? message.recentIds : ids),
          shortcuts: () => fromResponse(message),
        }),
        commands: message.data
          ? [
              SavedViewsCommands.PersistRecentSavedViews({
                ids: message.recentIds,
              }),
            ]
          : [],
      };
    },
    CompletedCancelLoadSavedViews: (message) =>
      message.version !== model.searchVersion ||
      !model.picker.isOpen ||
      model.pickerMode._tag === "Quick"
        ? { model }
        : {
            model,
            commands: [
              SavedViewsCommands.LoadSavedViews({
                version: message.version,
                query: searchText(model).trim(),
                more: message.more,
                debounce: message.debounce,
                cursor: message.more
                  ? (Option.getOrUndefined(AsyncData.getData(model.savedViews))
                      ?.nextCursor ?? null)
                  : null,
                pages: message.more ? 1 : model.savedViewPages,
              }),
            ],
          },
    LoadSavedViews: (message) =>
      AsyncData.isPending(model.savedViews)
        ? { model }
        : loadSavedViews(model, message.more),
    LoadedSavedViews: (message) => {
      if (message.version !== model.searchVersion || !model.picker.isOpen)
        return { model };
      const previous = AsyncData.getData(model.savedViews);
      const savedViews = message.data
        ? AsyncData.succeed({
            ...message.data,
            rows: message.more
              ? mergeSavedViews(
                  Option.getOrUndefined(previous)?.rows ?? [],
                  message.data.rows,
                )
              : message.data.rows,
          })
        : message.error
          ? AsyncData.settle(model.savedViews, Result.fail(message.error))
          : loadedOrIdle(previous);
      return {
        commands:
          message.more &&
          message.data &&
          !message.data.nextCursor &&
          model.picker.isOpen
            ? [SavedViewsCommands.FocusSavedViewSearch()]
            : [],
        model: modifyFields(model, {
          savedViewPages: (pages) =>
            message.data ? (message.more ? pages + 1 : message.pages) : pages,
          savedViews: () => savedViews,
        }),
      };
    },
  });
}

export function refreshBrowser(
  model: Model,
  removedId: string | null = null,
): FeatureUpdate<Model, Message> {
  const next = removedId
    ? modifyFields(model, {
        recentIds: (ids) => ids.filter((id) => id !== removedId),
      })
    : model;
  if (!next.picker.isOpen) return { model: next };
  const shortcuts = loadShortcuts(next, removedId);
  const results = loadSavedViews(shortcuts.model);
  return {
    ...results,
    commands: [...(shortcuts.commands ?? []), ...(results.commands ?? [])],
  };
}

export function selectBrowser(
  model: Model,
  id: string,
): FeatureUpdate<Model, Message> {
  const recentIds = rememberRecent(model.recentIds, id);
  const closed = clearBrowser(
    modifyFields(model, { recentIds: () => recentIds }),
  );
  return {
    ...closed,
    commands: [
      ...(closed.commands ?? []),
      SavedViewsCommands.RememberRecentSavedView({
        id,
        fallback: model.recentIds,
      }),
    ],
  };
}

export function clearBrowser(model: Model): FeatureUpdate<Model, Message> {
  const invalidated = invalidatePicker(model);
  const closed = foldPicker(invalidated.model, Popover.close(model.picker));
  return {
    ...closed,
    commands: [...(closed.commands ?? []), ...(invalidated.commands ?? [])],
  };
}
