import { Cache, Cause, Effect, Exit, Option } from "effect";

export interface PreviewChunk<Row, Error> {
  readonly pageCount: number;
  readonly rows: readonly Row[];
  readonly truncated: boolean;
  readonly readChunk: (
    index: number,
    offset: number,
  ) => Effect.Effect<readonly Row[], Error>;
}

export interface PreviewPage<Row> {
  readonly rows: readonly Row[];
  readonly nextCursor: string | null;
  readonly hasMoreMatches: boolean;
}

type ChunkPosition = { readonly index: number; readonly offset: number };
type Session<Search, Body, Error> = {
  readonly search: Search;
  readonly offsets: ReadonlyMap<number, number>;
  readonly readPage: (position: ChunkPosition) => Effect.Effect<Body, Error>;
};

export const makeRecordPreview = <
  Search,
  Row,
  Body,
  SourceError,
  EncodingError,
  CursorError,
  ConsistencyError,
>({
  start,
  encodePage,
  cacheable,
  invalidCursor,
  inconsistentPage,
}: {
  readonly start: (
    search: Search,
  ) => Effect.Effect<PreviewChunk<Row, SourceError>, SourceError>;
  readonly encodePage: (
    page: PreviewPage<Row>,
  ) => Effect.Effect<Body, EncodingError>;
  readonly cacheable: (search: Search) => boolean;
  readonly invalidCursor: () => CursorError;
  readonly inconsistentPage: () => ConsistencyError;
}) =>
  Effect.gen(function* () {
    type ReadError = SourceError | EncodingError | ConsistencyError;

    // The registry holds statement metadata only. An active reader can continue
    // after its preview bytes have expired or another search evicts them.
    const sessions = yield* Cache.make<
      string,
      Session<Search, Body, ReadError>,
      CursorError
    >({
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
            body: yield* encodePage({ rows, nextCursor: null, hasMoreMatches }),
          };
        const id = crypto.randomUUID();
        const offsets = new Map([[1, rows.length]]);
        const readPage = ({ index, offset }: ChunkPosition) =>
          Effect.gen(function* () {
            const rows = yield* readChunk(index, offset);
            const next = index + 1;
            const nextCursor = next < pageCount ? `${id}.${next}` : null;
            const body = yield* encodePage({
              rows,
              nextCursor,
              hasMoreMatches,
            });
            if (nextCursor !== null) {
              const nextOffset = offset + rows.length;
              const previous = offsets.get(next);
              if (previous !== undefined && previous !== nextOffset)
                return yield* Effect.fail(inconsistentPage());
              offsets.set(next, nextOffset);
            }
            return body;
          });
        const chunks = cacheChunks
          ? yield* Cache.makeWith(readPage, {
              capacity: pageCount - 1,
              timeToLive: (exit) => (Exit.isSuccess(exit) ? "60 seconds" : 0),
            })
          : undefined;
        return {
          body: yield* encodePage({
            rows,
            nextCursor: `${id}.1`,
            hasMoreMatches,
          }),
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
    const open = (search: Search) =>
      Effect.gen(function* () {
        const { body, continuation } = yield* cacheable(search)
          ? Cache.get(previews, search)
          : load(search, false);
        if (continuation)
          yield* Cache.set(sessions, continuation.id, continuation.session);
        return body;
      });

    const page = (cursor: string) =>
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
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Cache.invalidateWhen(
                  previews,
                  search,
                  (entry) => entry.continuation?.id === id,
                ),
          ),
        );
      });
    return { open, page };
  });
