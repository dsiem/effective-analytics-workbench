import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { Id } from "@dsiem/analytics-shared/schema";
import { TripSnapshot } from "@dsiem/analytics-shared/trips";
import { request } from "../../lib/api-client";
import { fail, result } from "../../lib/command-result";
import { Message as M } from "./messages";
export const LoadCommentCounts = Command.define("LoadCommentCounts", {
  args: {
    tripIds: Schema.Array(TripSnapshot.fields.trip_id),
    version: Schema.Int,
  },
  messages: [M.LoadedCommentCounts],
  execute: ({ tripIds, version }) =>
    result(
      request((client) => client.tripComments.counts({ query: { tripIds } })),
    ).pipe(
      Effect.map((result) =>
        M.LoadedCommentCounts({
          version,
          result:
            result._tag === "Success" &&
            !tripIds.every((id) => Object.hasOwn(result.data, id))
              ? fail("Some comment counts were missing from the response.")
              : result,
        }),
      ),
    ),
});
export const PostComment = Command.define("PostComment", {
  args: {
    trip: TripSnapshot,
    body: Schema.String,
    retryId: Schema.NullOr(Id),
  },
  messages: [M.PostedComment],
  execute: ({ trip, body, retryId }) =>
    Effect.gen(function* () {
      const input = { trip, body, id: retryId ?? crypto.randomUUID() };
      const posted = yield* result(
        request((client) => client.tripComments.add({ payload: input })),
      );
      return M.PostedComment({ input, result: posted });
    }),
});
