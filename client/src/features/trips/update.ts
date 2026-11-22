import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { Command } from "foldkit";
import type { Filters } from "../../../../shared/filters";
import { tripCommentCountLimit } from "../../../../shared/trip-comments";
import { syncDialog } from "../../lib/dialog";
import type { FeatureUpdate } from "../../lib/feature-update";
import { pending } from "../../lib/request-state";
import * as TripsCommands from "./commands";
import { Message as M, type Message } from "./messages";
import {
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
    counts.phase._tag === "Failed" ? counts.phase.error : null;
  return {
    model: {
      ...model,
      commentCounts: {
        ...counts,
        version,
        phase: { _tag: "Loading", previousError },
      },
    },
    commands: [TripsCommands.LoadCommentCounts({ tripIds, version })],
  };
}

function invalidateCommentCounts(
  counts: Model["commentCounts"],
): Model["commentCounts"] {
  const reset = emptyCommentCounts(counts.version);
  const error =
    counts.phase._tag === "Failed"
      ? counts.phase.error
      : counts.phase._tag === "Loading"
        ? counts.phase.previousError
        : null;
  return error ? { ...reset, phase: { _tag: "Failed", error } } : reset;
}

function resetList(model: Model): Model {
  return {
    ...model,
    viewport: null,
    preview: { _tag: "Idle" },
    loadGeneration: model.loadGeneration + 1,
    commentCounts: emptyCommentCounts(model.commentCounts.version),
    inspector: null,
  };
}

function comments(model: Model, more = false): FeatureUpdate<Model, Message> {
  if (!model.inspector) return { model };
  const thread = model.inspector.comments;
  return {
    model: {
      ...model,
      commentLoadGeneration: model.commentLoadGeneration + 1,
      inspector: {
        ...model.inspector,
        comments: {
          ...thread,
          error: "",
          read: { cursor: more ? (thread.data?.nextCursor ?? null) : null },
        },
      },
    },
  };
}

function updateTripsState(
  model: Model,
  message: Message,
): FeatureUpdate<Model, Message, Out> {
  switch (message._tag) {
    case "Idle":
      return { model };
    case "ResetTrips":
      return { model: resetList(model) };
    case "CloseTrip":
      return { model: { ...model, inspector: null } };
    case "InspectorDialog": {
      const changed = Dialog.update(model.inspectorDialog, message.message);
      return {
        model: {
          ...model,
          inspectorDialog: changed.model,
          inspector:
            changed.outMessage?._tag === "Closed" ? null : model.inspector,
        },
        commands: (changed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) =>
            M.InspectorDialog({ message }),
          ),
        ),
      };
    }
    case "TripBatchReceived": {
      const { preview } = model;
      if (
        message.generation !== model.loadGeneration ||
        preview._tag !== "Loading"
      )
        return { model };
      const rows = preview.rows.concat(message.rows);
      return countComments({ ...model, preview: { ...preview, rows } });
    }
    case "TripPreviewFinished": {
      const { preview } = model;
      if (
        message.generation !== model.loadGeneration ||
        preview._tag !== "Loading"
      )
        return { model };
      const { result } = message;
      return {
        model: {
          ...model,
          preview:
            result._tag === "Complete"
              ? { _tag: "Ready", rows: preview.rows, hasMore: result.hasMore }
              : { _tag: "Failed", rows: preview.rows, error: result.error },
        },
      };
    }
    case "LoadedCommentCounts": {
      const counts = model.commentCounts;
      if (counts.phase._tag !== "Loading" || message.version !== counts.version)
        return { model };
      return countComments({
        ...model,
        commentCounts: {
          ...counts,
          data: { ...counts.data, ...message.data },
          phase: message.error
            ? { _tag: "Failed", error: message.error }
            : { _tag: "Idle" },
        },
      });
    }
    case "RetryCommentCounts":
      return model.commentCounts.phase._tag === "Failed"
        ? countComments(model, true)
        : { model };
    case "TripsScrolled": {
      const { generation, viewport } = message;
      if (generation !== model.loadGeneration || model.preview._tag === "Idle")
        return { model };
      return countComments({ ...model, viewport });
    }
    case "SortTrips":
      return { model, outMessage: { _tag: "SortChanged", sort: message.sort } };
    case "SortMenu": {
      const changed = SortMenu.update(model.sortMenu, message.message);
      const sort = changed.outMessage?.value;
      return {
        model: { ...model, sortMenu: changed.model },
        commands:
          changed.commands?.map((command) =>
            Command.mapMessage(command, (message) => M.SortMenu({ message })),
          ) ?? [],
        ...(sort === undefined
          ? {}
          : { outMessage: { _tag: "SortChanged", sort } }),
      };
    }
    case "InspectTrip":
    case "InspectComments":
      return {
        model: {
          ...model,
          inspectorDialog: {
            ...model.inspectorDialog,
            maybeFocusSelector: Option.some(
              message._tag === "InspectComments"
                ? "#trip-comments-heading"
                : "#trip-details-dialog-title",
            ),
          },
          inspector: {
            trip: message.trip,
            details: pending,
            comments: { data: null, error: "", read: { cursor: null } },
          },
          detailLoadGeneration: model.detailLoadGeneration + 1,
          commentLoadGeneration: model.commentLoadGeneration + 1,
          postError: "",
          posted: "",
        },
      };
    case "RetryTripDetails": {
      const { inspector } = model;
      if (!inspector?.details.error) return { model };
      return {
        model: {
          ...model,
          inspector: { ...inspector, details: pending },
          detailLoadGeneration: model.detailLoadGeneration + 1,
        },
      };
    }
    case "LoadedTripDetails": {
      const { data, error, generation, tripId } = message;
      const { inspector } = model;
      if (
        generation !== model.detailLoadGeneration ||
        tripId !== inspector?.trip.trip_id ||
        !inspector.details.loading
      )
        return { model };
      return {
        model: {
          ...model,
          inspector: { ...inspector, details: { data, error, loading: false } },
        },
      };
    }
    case "LoadComments":
      return model.inspector?.comments.read
        ? { model }
        : comments(model, message.more);
    case "LoadedComments": {
      const { inspector } = model;
      if (
        message.generation !== model.commentLoadGeneration ||
        message.tripId !== inspector?.trip.trip_id ||
        !inspector.comments.read
      )
        return { model };
      const { data, read } = inspector.comments;
      return {
        model: {
          ...model,
          inspector: {
            ...inspector,
            comments: {
              read: null,
              error: message.error,
              data:
                message.data && read.cursor
                  ? {
                      ...message.data,
                      rows: [...(data?.rows ?? []), ...message.data.rows],
                    }
                  : (message.data ?? data),
            },
          },
        },
      };
    }
    case "CommentChanged": {
      const id = model.inspector?.trip.trip_id;
      if (!id || model.commentDrafts[id]?.body === message.body)
        return { model };
      return {
        model: {
          ...model,
          commentDrafts: {
            ...model.commentDrafts,
            [id]: { state: "editing", body: message.body },
          },
          postError: "",
          posted: "",
        },
      };
    }
    case "PostComment": {
      const selection = model.inspector?.trip;
      const draft = selection && model.commentDrafts[selection.trip_id];
      const trip =
        draft?.state === "retry"
          ? draft.trip
          : (model.inspector?.details.data ?? selection);
      if (!trip || !draft?.body.trim() || model.postingTripId) return { model };
      return {
        model: {
          ...model,
          postingTripId: trip.trip_id,
          commentDrafts: {
            ...model.commentDrafts,
            [trip.trip_id]: { state: "posting", body: draft.body },
          },
          postError: "",
          posted: "",
        },
        commands: [
          TripsCommands.PostComment({
            trip,
            body: draft.body,
            retryId: draft.state === "retry" ? draft.id : null,
          }),
        ],
      };
    }
    case "PostedComment": {
      const key = message.input.trip.trip_id;
      const drafts = { ...model.commentDrafts };
      if (drafts[key]?.state === "posting") {
        if (message.error) drafts[key] = { state: "retry", ...message.input };
        else delete drafts[key];
      }
      const next = {
        ...model,
        postingTripId: null,
        commentDrafts: drafts,
        posted: message.error ? "" : key,
        postError: model.inspector?.trip.trip_id === key ? message.error : "",
      };
      if (message.error) return { model: next };
      const counted = countComments({
        ...next,
        commentCounts: invalidateCommentCounts(next.commentCounts),
      });
      if (model.inspector?.trip.trip_id !== key) return counted;
      return { ...counted, model: comments(counted.model).model };
    }
  }
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
    model: {
      ...reset,
      preview: { _tag: "Loading", query: { filters, sort }, rows: [] },
    },
  };
}

export function updateTrips(
  model: Model,
  message: Message,
): FeatureUpdate<Model, Message, Out> {
  const result = updateTripsState(model, message);
  const dialog = syncDialog(
    result.model.inspectorDialog,
    result.model.inspector !== null,
  );
  return {
    ...result,
    model:
      dialog.model === result.model.inspectorDialog
        ? result.model
        : { ...result.model, inspectorDialog: dialog.model },
    commands: [
      ...(result.commands ?? []),
      ...(dialog.commands ?? []).map((command) =>
        Command.mapMessage(command, (message) =>
          M.InspectorDialog({ message }),
        ),
      ),
    ],
  };
}
