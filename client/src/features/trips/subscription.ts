import { Effect, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { TripCommentCursor } from "../../../../shared/trip-comments";
import { TripSummary } from "../../../../shared/trips";
import { type ApiClient, request } from "../../lib/api-client";
import { failure, result } from "../../lib/command-result";
import type { Notice } from "../../lib/request-state";
import { Message as M, type Message } from "./messages";
import { type Model, TripQuery } from "./model";

const PreviewRequest = Schema.Struct({
  ...TripQuery.fields,
  generation: Schema.Int,
});
const DetailRequest = Schema.Struct({
  tripId: TripSummary.fields.trip_id,
  generation: Schema.Int,
});
const CommentRequest = Schema.Struct({
  ...DetailRequest.fields,
  cursor: Schema.NullOr(TripCommentCursor),
});

function loadPreview({
  filters,
  sort,
  generation,
}: typeof PreviewRequest.Type) {
  const failed = (error: Notice) =>
    M.TripPreviewFinished({ generation, result: { _tag: "Failed", error } });

  const pages = Stream.suspend(() => {
    const visited = new Set<string>();
    return Stream.paginate(
      null,
      Effect.fnUntraced(function* (cursor: string | null) {
        const { rows, nextCursor, hasMoreMatches } = yield* request((client) =>
          cursor === null
            ? client.trips({ query: { ...filters, sort } })
            : client.tripPage({ params: { cursor } }),
        ).pipe(Effect.scoped);
        const messages: Message[] = rows.length
          ? [M.TripBatchReceived({ generation, rows })]
          : [];
        if (nextCursor === null) {
          messages.push(
            M.TripPreviewFinished({
              generation,
              result: { _tag: "Complete", hasMore: hasMoreMatches },
            }),
          );
          return [messages, Option.none<string>()] as const;
        }
        if (visited.has(nextCursor))
          return yield* Effect.fail(
            "The server repeated a trip page. Try again.",
          );
        visited.add(nextCursor);
        return [messages, Option.some(nextCursor)] as const;
      }),
    );
  });
  return pages.pipe(
    Stream.interruptWhen(
      Effect.sleep("2 minutes").pipe(
        Effect.andThen(Effect.fail("Trip records timed out. Try again.")),
      ),
    ),
    Stream.catch((error) =>
      Stream.succeed(
        failed(typeof error === "string" ? error : failure(error)),
      ),
    ),
  );
}

function loadDetails({ tripId, generation }: typeof DetailRequest.Type) {
  return Stream.fromEffect(
    result(request((client) => client.tripDetails({ query: { tripId } }))).pipe(
      Effect.map(({ data, error }) =>
        M.LoadedTripDetails({
          tripId,
          generation,
          ...(data && data.trip_id !== tripId
            ? {
                data: null,
                error: "Trip details did not match the selected record.",
              }
            : { data, error }),
        }),
      ),
    ),
  );
}

function loadComments({
  tripId,
  generation,
  cursor,
}: typeof CommentRequest.Type) {
  return Stream.fromEffect(
    result(
      request((client) =>
        client.tripComments({
          query: cursor ? { tripId, cursor } : { tripId },
        }),
      ),
    ).pipe(
      Effect.map((read) => M.LoadedComments({ tripId, generation, ...read })),
    ),
  );
}

export const subscriptions = Subscription.make<Model, Message, ApiClient>()(
  (entry) => ({
    trips: entry(
      { request: Schema.NullOr(PreviewRequest) },
      {
        modelToDependencies: ({ preview, loadGeneration }) => ({
          request:
            preview._tag === "Loading"
              ? { ...preview.query, generation: loadGeneration }
              : null,
        }),
        dependenciesToStream: ({ request }) =>
          request ? loadPreview(request) : Stream.empty,
      },
    ),
    details: entry(
      { request: Schema.NullOr(DetailRequest) },
      {
        modelToDependencies: ({ inspector, detailLoadGeneration }) => ({
          request: inspector?.details.loading
            ? {
                tripId: inspector.trip.trip_id,
                generation: detailLoadGeneration,
              }
            : null,
        }),
        dependenciesToStream: ({ request }) =>
          request ? loadDetails(request) : Stream.empty,
      },
    ),
    comments: entry(
      { request: Schema.NullOr(CommentRequest) },
      {
        modelToDependencies: ({ inspector, commentLoadGeneration }) => ({
          request: inspector?.comments.read
            ? {
                tripId: inspector.trip.trip_id,
                generation: commentLoadGeneration,
                cursor: inspector.comments.read.cursor,
              }
            : null,
        }),
        dependenciesToStream: ({ request }) =>
          request ? loadComments(request) : Stream.empty,
      },
    ),
  }),
);
