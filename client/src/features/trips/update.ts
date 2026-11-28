import { Dialog, Menu } from "@foldkit/ui";
import { Match, Option, Struct } from "effect";
import { Command } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { tripCommentCountLimit } from "@dsiem/analytics-shared/trip-comments";
import { syncDialog } from "../../lib/dialog";
import type { FeatureUpdate } from "../../lib/feature-update";
import { inspection, records } from "./records";
import * as TripsCommands from "./commands";
import { Message as M, type Message } from "./messages";
import {
  CommentCountPhase,
  emptyCommentCounts,
  type Model,
  type Sort,
  previewRows,
  SortMenu,
  tripWindow,
} from "./model";

function countComments(
  model: Model,
  retry = false,
): FeatureUpdate<Model, Message> {
  const counts = model.commentCounts;
  if (counts.phase._tag === "Loading") return { model };
  if (counts.phase._tag === "Failed" && !retry) return { model };
  const rows = previewRows(model.preview);
  const { visibleStart, visibleEnd } = tripWindow(rows.length, model.viewport);
  const tripIds = rows
    .slice(visibleStart, visibleEnd)
    .map(({ trip_id }) => trip_id)
    .filter((id) => retry || !Object.hasOwn(counts.data, id))
    .slice(0, tripCommentCountLimit);
  if (!tripIds.length) return { model };
  const version = counts.version + 1;
  const previousError =
    counts.phase._tag === "Failed"
      ? Option.some(counts.phase.error)
      : Option.none();
  return {
    model: modifyFields(model, {
      commentCounts: (counts) =>
        modifyFields(counts, {
          version: () => version,
          phase: () => CommentCountPhase.Loading({ previousError }),
        }),
    }),
    commands: [TripsCommands.LoadCommentCounts({ tripIds, version })],
  };
}

function invalidateCommentCounts(
  counts: Model["commentCounts"],
): Model["commentCounts"] {
  const reset = emptyCommentCounts(counts.version);
  const previousError = CommentCountPhase.match(counts.phase, {
    Failed: ({ error }) => Option.some(error),
    Loading: ({ previousError }) => previousError,
    Idle: () => Option.none(),
  });
  return Option.isSome(previousError)
    ? {
        ...reset,
        phase: CommentCountPhase.Failed({ error: previousError.value }),
      }
    : reset;
}

function resetList(model: Model): Model {
  return {
    ...records.reset(model),
    viewport: Option.none(),
    inspector: Option.none(),
    commentCounts: emptyCommentCounts(model.commentCounts.version),
  };
}

function updateTripsState(
  model: Model,
  message: Message,
): FeatureUpdate<Model, Message, Out> {
  function inspect(
    message: ReturnType<typeof M.InspectTrip | typeof M.InspectComments>,
  ) {
    const focusSelector =
      message._tag === "InspectTrip"
        ? "#trip-details-dialog-title"
        : "#trip-comments-heading";
    const changed = inspection.update(
      model,
      inspection.Message.Inspect({ row: message.trip }),
    );
    return {
      model: {
        ...changed.model,
        inspectorDialog: {
          ...model.inspectorDialog,
          maybeFocusSelector: Option.some(focusSelector),
        },
      },
    };
  }
  const updateInspection = (
    message: typeof inspection.Message.Type,
  ): FeatureUpdate<Model, Message> => {
    const changed = inspection.update(model, message);
    if (changed.outMessage)
      return countComments({
        ...changed.model,
        commentCounts: invalidateCommentCounts(changed.model.commentCounts),
      });
    return {
      model: changed.model,
      ...(changed.commands ? { commands: changed.commands } : {}),
    };
  };
  return Match.value(message).pipe(
    Match.tags({
      ResetTrips: () => ({ model: resetList(model) }),
      GotInspectorDialogMessage: (message) => {
        const changed = Dialog.update(model.inspectorDialog, message.message);
        return {
          model: modifyFields(model, {
            inspectorDialog: () => changed.model,
            inspector: (inspector) =>
              changed.outMessage?._tag === "Closed" ? Option.none() : inspector,
          }),
          commands: (changed.commands ?? []).map((command) =>
            Command.mapMessage(command, (message) =>
              M.GotInspectorDialogMessage({ message }),
            ),
          ),
        };
      },
      RecordBatch: (message) => {
        const next = records.update(model, message);
        return next === model ? { model } : countComments(next);
      },
      RecordsFinished: (message) => ({ model: records.update(model, message) }),
      Listed: (message) => ({ model: records.update(model, message) }),
      LoadedCommentCounts: (message) => {
        const counts = model.commentCounts;
        if (
          counts.phase._tag !== "Loading" ||
          message.version !== counts.version
        )
          return { model };
        const { result } = message;
        return countComments(
          modifyFields(model, {
            commentCounts: (counts) =>
              modifyFields(counts, {
                data: (data) =>
                  result._tag === "Success"
                    ? Struct.assign(data, result.data)
                    : data,
                phase: () =>
                  result._tag === "Failure"
                    ? CommentCountPhase.Failed({ error: result.error })
                    : CommentCountPhase.Idle(),
              }),
          }),
        );
      },
      RetryCommentCounts: () => {
        return model.commentCounts.phase._tag === "Failed"
          ? countComments(model, true)
          : { model };
      },
      TripsScrolled: (message) => {
        const { generation, viewport } = message;
        if (
          generation !== model.loadGeneration ||
          model.preview._tag === "Idle"
        )
          return { model };
        return countComments(
          modifyFields(model, { viewport: () => Option.some(viewport) }),
        );
      },
      SortTrips: (message) => ({
        model,
        outMessage: { _tag: "SortChanged" as const, sort: message.sort },
      }),
      GotSortMenuMessage: (message) => {
        const changed = SortMenu.update(model.sortMenu, message.message);
        const sort = changed.outMessage?.value;
        return {
          model: modifyFields(model, { sortMenu: () => changed.model }),
          commands:
            changed.commands?.map((command) =>
              Command.mapMessage(command, (message) =>
                M.GotSortMenuMessage({ message }),
              ),
            ) ?? [],
          ...(sort === undefined
            ? {}
            : { outMessage: { _tag: "SortChanged" as const, sort } }),
        };
      },
      InspectTrip: inspect,
      InspectComments: inspect,
    }),
    Match.orElse(updateInspection),
  );
}

export type Out = {
  readonly _tag: "SortChanged";
  readonly sort: typeof Sort.Type;
};

export function reloadTrips(
  model: Model,
  { filters, sort }: { filters: Filters; sort: typeof Sort.Type },
): FeatureUpdate<Model, Message> {
  return records.load<Model>(
    {
      ...model,
      viewport: Option.none(),
      inspector: Option.none(),
      commentCounts: emptyCommentCounts(model.commentCounts.version),
    },
    { filters, sort },
  );
}

export function updateTrips(
  model: Model,
  message: Message,
): FeatureUpdate<Model, Message, Out> {
  const result = updateTripsState(model, message);
  const dialog = syncDialog(
    result.model.inspectorDialog,
    Option.isSome(result.model.inspector),
  );
  return {
    ...result,
    model:
      dialog.model === result.model.inspectorDialog
        ? result.model
        : modifyFields(result.model, { inspectorDialog: () => dialog.model }),
    commands: [
      ...(result.commands ?? []),
      ...(dialog.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) =>
          M.GotInspectorDialogMessage({ message }),
        ),
      ),
    ],
  };
}

export function resetTrips(current: Model): FeatureUpdate<Model, Message> {
  const { model, commands } = updateTrips(current, M.ResetTrips());
  return commands ? { model, commands } : { model };
}

export function closeSortMenu(current: Model): FeatureUpdate<Model, Message> {
  const { model, commands } = updateTrips(
    current,
    M.GotSortMenuMessage({ message: Menu.Message.Closed() }),
  );
  return commands ? { model, commands } : { model };
}
