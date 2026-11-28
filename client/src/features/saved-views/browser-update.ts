import { Popover } from "@foldkit/ui";
import { Option } from "effect";
import { AsyncData, Command, type Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { FeatureUpdate } from "../../lib/feature-update";
import type { Model } from "./browser-model";
import * as SavedViewsCommands from "./commands";
import {
  BrowserMessage as M,
  type BrowserMessage,
  findingSearch,
  type Message,
} from "./messages";
import { rememberRecent } from "./picker";
import { search } from "./workflow";

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
    model: { ...model, picker: changed.model },
    commands: Command.mapMessages(changed.commands, (message) =>
      M.GotSavedViewsPickerMessage({ message }),
    ),
  };
}

function updateSearch(
  model: Model,
  message: typeof search.Message.Type,
): FeatureUpdate<Model, Message> {
  const changed = search.update(model.search, message);
  return {
    model:
      changed.model === model.search
        ? model
        : { ...model, search: changed.model },
    commands: [
      ...Command.mapMessages(changed.commands, findingSearch),
      ...(changed.outMessage?._tag === "ReachedEnd"
        ? [SavedViewsCommands.FocusSavedViewSearch()]
        : []),
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

function invalidatePicker(model: Model) {
  return updateSearch(
    modifyFields(model, {
      pickerMode: () => "Quick",
      shortcutVersion: (version) => version + 1,
      shortcuts: (shortcuts) =>
        AsyncData.isPending(shortcuts)
          ? loadedOrIdle(AsyncData.getData(shortcuts))
          : shortcuts,
    }),
    search.Message.Reset({ retainResults: true }),
  );
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
      const next =
        changed.outMessage?._tag === "Closed"
          ? invalidatePicker(folded.model)
          : changed.outMessage?._tag === "Opened"
            ? loadShortcuts({ ...folded.model, pickerMode: "Quick" })
            : folded;
      return next === folded
        ? folded
        : {
            ...next,
            commands: [...(folded.commands ?? []), ...(next.commands ?? [])],
          };
    },
    SavedViewSearchChanged: ({ value }) =>
      value
        ? updateSearch(
            { ...model, pickerMode: "Search" },
            search.Message.Search({ value }),
          )
        : updateSearch(
            { ...model, pickerMode: "Quick" },
            search.Message.Reset({ retainResults: false }),
          ),
    BrowseSavedViews: () => {
      const opened = updateSearch(
        { ...model, pickerMode: "Browse" },
        search.Message.Browse(),
      );
      return {
        ...opened,
        commands: [
          ...(opened.commands ?? []),
          SavedViewsCommands.FocusSavedViewSearch(),
        ],
      };
    },
    ShowSavedViewShortcuts: () => {
      const opened = updateSearch(
        { ...model, pickerMode: "Quick" },
        search.Message.Reset({ retainResults: false }),
      );
      return {
        ...opened,
        commands: [
          ...(opened.commands ?? []),
          SavedViewsCommands.FocusSavedViewSearch(),
        ],
      };
    },
    LoadSavedViewShortcuts: () => loadShortcuts(model),
    LoadedSavedViewShortcuts: ({ version, result, recentIds }) => {
      if (version !== model.shortcutVersion || !model.picker.isOpen)
        return { model };
      const loaded = result._tag === "Success";
      return {
        model: {
          ...model,
          recentIds: loaded ? recentIds : model.recentIds,
          shortcuts: result,
        },
        commands: loaded
          ? [SavedViewsCommands.PersistRecentSavedViews({ ids: recentIds })]
          : [],
      };
    },
    GotFindingSearchMessage: ({ message }) =>
      model.picker.isOpen && model.pickerMode !== "Quick"
        ? updateSearch(model, message)
        : { model },
  });
}

export function refreshBrowser(
  model: Model,
  removedId: string | null = null,
): FeatureUpdate<Model, Message> {
  const next = removedId
    ? { ...model, recentIds: model.recentIds.filter((id) => id !== removedId) }
    : model;
  if (!next.picker.isOpen) return { model: next };
  const shortcuts = loadShortcuts(next, removedId);
  if (next.pickerMode === "Quick") return shortcuts;
  const refreshed = updateSearch(shortcuts.model, search.Message.Refresh());
  return {
    ...refreshed,
    commands: [...(shortcuts.commands ?? []), ...(refreshed.commands ?? [])],
  };
}

export function selectBrowser(
  model: Model,
  id: string,
): FeatureUpdate<Model, Message> {
  const closed = clearBrowser({
    ...model,
    recentIds: rememberRecent(model.recentIds, id),
  });
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
