import { Dialog, Menu } from "@foldkit/ui";
import { Option, Struct } from "effect";
import { AsyncData, Command } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Filters } from "@dsiem/analytics-shared/filters";
import { tripCommentCountLimit } from "@dsiem/analytics-shared/trip-comments";
import type { TripSummary } from "@dsiem/analytics-shared/trips";
import { syncDialog } from "../../lib/dialog";
import type { FeatureUpdate } from "../../lib/feature-update";
import { fromResponse } from "../../lib/request-state";
import * as TripsCommands from "./commands";
import { Message as M, type Message } from "./messages";
import {
  CommentCountPhase,
  emptyCommentCounts,
  type Model,
  type Sort,
  previewRows,
  SortMenu,
  TripPreview,
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
  return modifyFields(model, {
    viewport: Option.none,
    preview: () => TripPreview.Idle(),
    loadGeneration: (generation) => generation + 1,
    commentCounts: ({ version }) => emptyCommentCounts(version),
    inspector: Option.none,
  });
}

function comments(model: Model, more = false): FeatureUpdate<Model, Message> {
  if (Option.isNone(model.inspector)) return { model };
  const inspector = model.inspector.value;
  const thread = inspector.comments;
  const cursor = more
    ? Option.flatMapNullishOr(thread.data, ({ nextCursor }) => nextCursor)
    : Option.none();
  return {
    model: modifyFields(model, {
      commentLoadGeneration: (generation) => generation + 1,
      inspector: () =>
        Option.some({
          ...inspector,
          comments: {
            ...thread,
            error: "",
            read: Option.some({ cursor }),
          },
        }),
    }),
  };
}

function inspect(
  model: Model,
  trip: TripSummary,
  focusSelector: string,
): FeatureUpdate<Model, Message> {
  return {
    model: modifyFields(model, {
      inspectorDialog: (dialog) =>
        modifyFields(dialog, {
          maybeFocusSelector: () => Option.some(focusSelector),
        }),
      inspector: () =>
        Option.some({
          trip,
          details: AsyncData.Loading(),
          comments: {
            data: Option.none(),
            error: "",
            read: Option.some({ cursor: Option.none() }),
          },
        }),
      detailLoadGeneration: (generation) => generation + 1,
      commentLoadGeneration: (generation) => generation + 1,
      postError: () => "",
      posted: () => "",
    }),
  };
}

function updateTripsState(
  model: Model,
  message: Message,
): FeatureUpdate<Model, Message, Out> {
  return M.match<FeatureUpdate<Model, Message, Out>>(message, {
    ResetTrips: () => ({ model: resetList(model) }),
    CloseTrip: () => ({
      model: modifyFields(model, { inspector: Option.none }),
    }),
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
    TripBatchReceived: (message) => {
      const { preview } = model;
      if (
        message.generation !== model.loadGeneration ||
        preview._tag !== "Loading"
      )
        return { model };
      const rows = preview.rows.concat(message.rows);
      return countComments(
        modifyFields(model, {
          preview: () => TripPreview.Loading({ query: preview.query, rows }),
        }),
      );
    },
    TripPreviewFinished: (message) => {
      const { preview } = model;
      if (
        message.generation !== model.loadGeneration ||
        preview._tag !== "Loading"
      )
        return { model };
      const { result } = message;
      return {
        model: modifyFields(model, {
          preview: () =>
            result._tag === "Complete"
              ? TripPreview.Ready({
                  rows: preview.rows,
                  hasMore: result.hasMore,
                })
              : TripPreview.Failed({ rows: preview.rows, error: result.error }),
        }),
      };
    },
    LoadedCommentCounts: (message) => {
      const counts = model.commentCounts;
      if (counts.phase._tag !== "Loading" || message.version !== counts.version)
        return { model };
      return countComments(
        modifyFields(model, {
          commentCounts: (counts) =>
            modifyFields(counts, {
              data: (data) =>
                message.data ? Struct.assign(data, message.data) : data,
              phase: () =>
                message.error
                  ? CommentCountPhase.Failed({ error: message.error })
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
      if (generation !== model.loadGeneration || model.preview._tag === "Idle")
        return { model };
      return countComments(
        modifyFields(model, { viewport: () => Option.some(viewport) }),
      );
    },
    SortTrips: (message) => ({
      model,
      outMessage: { _tag: "SortChanged", sort: message.sort },
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
          : { outMessage: { _tag: "SortChanged", sort } }),
      };
    },
    InspectTrip: (message) =>
      inspect(model, message.trip, "#trip-details-dialog-title"),
    InspectComments: (message) =>
      inspect(model, message.trip, "#trip-comments-heading"),
    RetryTripDetails: () => {
      const inspector = Option.getOrUndefined(model.inspector);
      if (!inspector || !AsyncData.hasError(inspector.details))
        return { model };
      return {
        model: modifyFields(model, {
          inspector: () =>
            Option.some({
              ...inspector,
              details: AsyncData.Loading(),
            }),
          detailLoadGeneration: (generation) => generation + 1,
        }),
      };
    },
    LoadedTripDetails: (message) => {
      const { generation, tripId } = message;
      const inspector = Option.getOrUndefined(model.inspector);
      if (
        generation !== model.detailLoadGeneration ||
        tripId !== inspector?.trip.trip_id ||
        !AsyncData.isPending(inspector.details)
      )
        return { model };
      return {
        model: modifyFields(model, {
          inspector: () =>
            Option.some({
              ...inspector,
              details: fromResponse(message),
            }),
        }),
      };
    },
    LoadComments: (message) => {
      return Option.exists(model.inspector, ({ comments }) =>
        Option.isSome(comments.read),
      )
        ? { model }
        : comments(model, message.more);
    },
    LoadedComments: (message) => {
      const inspector = Option.getOrUndefined(model.inspector);
      if (
        message.generation !== model.commentLoadGeneration ||
        message.tripId !== inspector?.trip.trip_id ||
        Option.isNone(inspector.comments.read)
      )
        return { model };
      const { data, read } = inspector.comments;
      const page = message.data;
      return {
        model: modifyFields(model, {
          inspector: () =>
            Option.some({
              ...inspector,
              comments: {
                read: Option.none(),
                error: message.error,
                data:
                  page && Option.isSome(read.value.cursor)
                    ? Option.some({
                        ...page,
                        rows: [
                          ...(Option.getOrUndefined(data)?.rows ?? []),
                          ...page.rows,
                        ],
                      })
                    : Option.orElse(Option.fromNullishOr(page), () => data),
              },
            }),
        }),
      };
    },
    CommentChanged: (message) => {
      const id = Option.getOrUndefined(model.inspector)?.trip.trip_id;
      if (!id || model.commentDrafts[id]?.body === message.body)
        return { model };
      return {
        model: modifyFields(model, {
          commentDrafts: (drafts) => ({
            ...drafts,
            [id]: { state: "editing", body: message.body },
          }),
          postError: () => "",
          posted: () => "",
        }),
      };
    },
    PostComment: () => {
      const inspector = Option.getOrUndefined(model.inspector);
      const selection = inspector?.trip;
      const draft = selection && model.commentDrafts[selection.trip_id];
      const trip =
        draft?.state === "retry"
          ? draft.trip
          : inspector && AsyncData.isSuccess(inspector.details)
            ? inspector.details.data
            : selection;
      if (!trip || !draft?.body.trim() || Option.isSome(model.postingTripId))
        return { model };
      return {
        model: modifyFields(model, {
          postingTripId: () => Option.some(trip.trip_id),
          commentDrafts: (drafts) => ({
            ...drafts,
            [trip.trip_id]: { state: "posting", body: draft.body },
          }),
          postError: () => "",
          posted: () => "",
        }),
        commands: [
          TripsCommands.PostComment({
            trip,
            body: draft.body,
            retryId: draft.state === "retry" ? draft.id : null,
          }),
        ],
      };
    },
    PostedComment: (message) => {
      const key = message.input.trip.trip_id;
      const drafts = { ...model.commentDrafts };
      if (drafts[key]?.state === "posting") {
        if (message.error) drafts[key] = { state: "retry", ...message.input };
        else delete drafts[key];
      }
      const selectedId = Option.getOrUndefined(model.inspector)?.trip.trip_id;
      const next = modifyFields(model, {
        postingTripId: Option.none,
        commentDrafts: () => drafts,
        posted: () => (message.error ? "" : key),
        postError: () => (selectedId === key ? message.error : ""),
      });
      if (message.error) return { model: next };
      const counted = countComments(
        modifyFields(next, {
          commentCounts: invalidateCommentCounts,
        }),
      );
      if (selectedId !== key) return counted;
      return { ...counted, model: comments(counted.model).model };
    },
  });
}

export type Out = {
  readonly _tag: "SortChanged";
  readonly sort: typeof Sort.Type;
};

export function reloadTrips(
  model: Model,
  { filters, sort }: { filters: Filters; sort: typeof Sort.Type },
): FeatureUpdate<Model, Message> {
  const reset = resetList(model);
  return {
    model: modifyFields(reset, {
      preview: () =>
        TripPreview.Loading({ query: { filters, sort }, rows: [] }),
    }),
  };
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
