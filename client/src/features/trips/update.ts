import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { Command } from "foldkit";
import type { Filters } from "../../../../shared/filters";
import { syncDialog } from "../../lib/dialog";
import type { FeatureUpdate } from "../../lib/feature-update";
import { empty } from "../../lib/request-state";
import * as TripsCommands from "./commands";
import { Message as M, type Message } from "./messages";
import { type Model, type Sort, tripPageNumber } from "./model";

function countComments(model: Model): FeatureUpdate<Model, Message, Out> {
  const tripIds = model.trips.data?.rows.map((trip) => trip.trip_id) ?? [];
  const version = model.commentCountsVersion + 1;
  return {
    model: {
      ...model,
      commentCountsVersion: version,
      commentCounts: { ...model.commentCounts, loading: !!tripIds.length },
    },
    commands: tripIds.length
      ? [TripsCommands.LoadCommentCounts({ tripIds, version })]
      : [],
  };
}

function comments(
  model: Model,
  more = false,
): FeatureUpdate<Model, Message, Out> {
  if (!model.selectedTrip) return { model };
  const generation = model.commentLoadGeneration + 1;
  return {
    model: {
      ...model,
      commentLoadGeneration: generation,
      comments: { ...model.comments, loading: true, error: "" },
    },
    commands: [
      TripsCommands.LoadComments({
        tripId: model.selectedTrip.trip_id,
        generation,
        cursor: more ? (model.comments.data?.nextCursor ?? null) : null,
        more,
      }),
    ],
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
      return {
        model: {
          ...model,
          loadGeneration: model.loadGeneration + 1,
          pageCursors: [],
          trips: empty,
          selectedTrip: null,
        },
      };
    case "CloseTrip":
      return { model: { ...model, selectedTrip: null } };
    case "InspectorDialog": {
      const changed = Dialog.update(model.inspectorDialog, message.message);
      return {
        model: {
          ...model,
          inspectorDialog: changed.model,
          selectedTrip:
            changed.outMessage?._tag === "Closed" ? null : model.selectedTrip,
        },
        commands: (changed.commands ?? []).map((command) =>
          Command.mapMessage(command, (message) =>
            M.InspectorDialog({ message }),
          ),
        ),
      };
    }
    case "LoadedTrips":
      return message.generation !== model.loadGeneration
        ? { model }
        : {
            outMessage: { _tag: "SelectionInvalidated" },
            ...countComments({
              ...model,
              commentCounts: empty,
              displayedPage: tripPageNumber(model),
              trips: {
                data: message.data,
                error: message.error,
                loading: false,
              },
            }),
          };
    case "LoadedCommentCounts":
      return message.version !== model.commentCountsVersion
        ? { model }
        : {
            model: {
              ...model,
              commentCounts: {
                data: message.data,
                error: message.error,
                loading: false,
              },
            },
          };
    case "NextPage": {
      const cursor = model.trips.data?.nextCursor;
      if (!cursor || model.trips.loading) return { model };
      return {
        model: { ...model, pageCursors: [...model.pageCursors, cursor] },
        outMessage: { _tag: "Reload" },
      };
    }
    case "PreviousPage":
      if (!model.pageCursors.length || model.trips.loading) return { model };
      return {
        model: { ...model, pageCursors: model.pageCursors.slice(0, -1) },
        outMessage: { _tag: "Reload" },
      };
    case "SortTrips":
      return {
        model: { ...model, pageCursors: [], trips: empty },
        outMessage: { _tag: "SortChanged", sort: message.sort },
      };
    case "InspectTrip":
    case "InspectComments":
      return comments({
        ...model,
        inspectorDialog: {
          ...model.inspectorDialog,
          maybeFocusSelector: Option.some(
            message._tag === "InspectComments"
              ? "#trip-comments-heading"
              : "#trip-details-dialog-title",
          ),
        },
        selectedTrip: message.trip,
        comments: empty,
        postError: "",
        posted: "",
      });
    case "LoadComments":
      return model.comments.loading ? { model } : comments(model, message.more);
    case "LoadedComments":
      return message.generation !== model.commentLoadGeneration ||
        message.tripId !== model.selectedTrip?.trip_id
        ? { model }
        : {
            model: {
              ...model,
              comments: {
                loading: false,
                error: message.error,
                data: message.data
                  ? {
                      ...message.data,
                      rows: message.more
                        ? [
                            ...(model.comments.data?.rows ?? []),
                            ...message.data.rows,
                          ]
                        : message.data.rows,
                    }
                  : model.comments.data,
              },
            },
          };
    case "CommentChanged": {
      const id = model.selectedTrip?.trip_id;
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
      const trip = model.selectedTrip;
      const draft = trip && model.commentDrafts[trip.trip_id];
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
            trip: draft.state === "retry" ? draft.trip : trip,
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
        postError: model.selectedTrip?.trip_id === key ? message.error : "",
      };
      if (message.error) return { model: next };
      const counted = countComments(next);
      if (model.selectedTrip?.trip_id !== key) return counted;
      const refreshed = comments(counted.model);
      return {
        ...refreshed,
        commands: [...(counted.commands ?? []), ...(refreshed.commands ?? [])],
      };
    }
  }
}

export type Out =
  | { readonly _tag: "Reload" }
  | { readonly _tag: "SortChanged"; readonly sort: typeof Sort.Type }
  | { readonly _tag: "SelectionInvalidated" };

export function reloadTrips(
  model: Model,
  { filters, sort }: { filters: Filters; sort: typeof Sort.Type },
): FeatureUpdate<Model, Message> {
  const generation = model.loadGeneration + 1;
  return {
    model: {
      ...model,
      loadGeneration: generation,
      trips: { ...model.trips, error: "", loading: true },
    },
    commands: [
      TripsCommands.LoadTrips({
        generation,
        filters,
        cursor: model.pageCursors.at(-1) ?? null,
        sort,
      }),
    ],
  };
}

export function updateTrips(
  model: Model,
  message: Message,
): FeatureUpdate<Model, Message, Out> {
  const result = updateTripsState(model, message);
  const dialog = syncDialog(
    result.model.inspectorDialog,
    result.model.selectedTrip !== null,
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
