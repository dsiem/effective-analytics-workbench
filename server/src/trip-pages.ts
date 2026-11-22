import { randomUUID } from "node:crypto";
import { Cache, Effect, Exit, Option } from "effect";
import {
  defaultTripLimit,
  type TripPage,
  type TripSearch,
  type TripSort,
  type TripSummary,
} from "../../shared/trips.js";
import {
  InvalidRequest,
  type ServiceUnavailable,
  unavailable,
} from "./errors.js";

const encoder = new TextEncoder();
const encodePage = (page: TripPage) => encoder.encode(JSON.stringify(page));

type Search = TripSearch & {
  readonly limit: number;
  readonly sort: typeof TripSort.Type;
};
type ChunkPosition = { readonly index: number; readonly offset: number };
type Session<E> = {
  readonly search: Search;
  readonly offsets: ReadonlyMap<number, number>;
  readonly readPage: (
    position: ChunkPosition,
  ) => Effect.Effect<Uint8Array, E | ServiceUnavailable>;
};
const invalidCursor = () =>
  new InvalidRequest({
    message: "This trip page cursor is invalid or expired. Reload the preview.",
  });

export const makeTripPages = <E>(
  start: (search: Search) => Effect.Effect<
    {
      readonly pageCount: number;
      readonly rows: readonly TripSummary[];
      readonly truncated: boolean;
      readonly readChunk: (
        index: number,
        offset: number,
      ) => Effect.Effect<readonly TripSummary[], E>;
    },
    E
  >,
) =>
  Effect.gen(function* () {
    // The registry holds statement metadata only. An active reader can continue
    // after its preview bytes have expired or another search evicts them.
    const sessions = yield* Cache.make<string, Session<E>, InvalidRequest>({
      lookup: () => Effect.fail(invalidCursor()),
      capacity: 256,
      timeToLive: "15 minutes",
    });
    const load = (search: Search, cacheChunks: boolean) =>
      Effect.gen(function* () {
        const {
          pageCount,
          rows,
          truncated: hasMoreMatches,
          readChunk,
        } = yield* start(search);
        if (pageCount <= 1)
          return {
            body: encodePage({ rows, nextCursor: null, hasMoreMatches }),
          };
        const id = randomUUID();
        const offsets = new Map([[1, rows.length]]);
        const readPage = ({ index, offset }: ChunkPosition) =>
          Effect.gen(function* () {
            const rows = yield* readChunk(index, offset);
            const next = index + 1;
            const nextCursor = next < pageCount ? `${id}.${next}` : null;
            if (nextCursor !== null) {
              const nextOffset = offset + rows.length;
              const previous = offsets.get(next);
              if (previous !== undefined && previous !== nextOffset)
                return yield* Effect.fail(
                  unavailable(
                    "warehouse",
                    "The warehouse returned an inconsistent trip page. Reload the preview.",
                  ),
                );
              offsets.set(next, nextOffset);
            }
            return encodePage({ rows, nextCursor, hasMoreMatches });
          });
        const chunks = cacheChunks
          ? yield* Cache.makeWith(readPage, {
              capacity: pageCount - 1,
              timeToLive: (exit) => (Exit.isSuccess(exit) ? "60 seconds" : 0),
            })
          : undefined;
        return {
          body: encodePage({ rows, nextCursor: `${id}.1`, hasMoreMatches }),
          continuation: {
            id,
            session: { search, offsets, readPage },
            chunks,
          },
        };
      });
    const previews = yield* Cache.makeWith(
      (search: Search) => load(search, true),
      {
        capacity: 2,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "60 seconds" : 0),
      },
    );
    const trips = ({
      sort = "newest",
      limit = defaultTripLimit,
      ...filters
    }: TripSearch) =>
      Effect.gen(function* () {
        const search = { sort, limit, ...filters };
        const { body, continuation } = yield* limit <= defaultTripLimit
          ? Cache.get(previews, search)
          : load(search, false);
        if (continuation)
          yield* Cache.set(sessions, continuation.id, continuation.session);
        return body;
      }).pipe(Effect.withSpan("analytics.trips"));

    const tripPage = (cursor: string) =>
      Effect.gen(function* () {
        const match = /^([\da-f-]{36})\.([1-9]\d{0,9})$/.exec(cursor);
        if (!match?.[1]) return yield* Effect.fail(invalidCursor());
        const id = match[1];
        const index = Number(match[2]);
        const session = Option.getOrUndefined(
          yield* Cache.getSuccess(sessions, id),
        );
        const offset = session?.offsets.get(index);
        if (!session || offset === undefined)
          return yield* Effect.fail(invalidCursor());
        const { search, readPage } = session;
        const cached = yield* Cache.getSuccess(previews, search);
        const continuation = Option.getOrUndefined(cached)?.continuation;
        const position = { index, offset };
        return yield* (
          continuation?.id === id && continuation.chunks
            ? Cache.get(continuation.chunks, position)
            : readPage(position)
        ).pipe(
          Effect.tapError(() =>
            Cache.invalidateWhen(
              previews,
              search,
              (entry) => entry.continuation?.id === id,
            ),
          ),
        );
      }).pipe(Effect.withSpan("analytics.tripPage"));
    return { trips, tripPage };
  });
