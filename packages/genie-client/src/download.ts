import {
  Clock,
  Data,
  Effect,
  Exit,
  Option,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { scopedFetchBody } from "./fetch-body.js";
import { chatPaths, GenieId, type GenieQueryReference } from "./protocol.js";

export type GenieDownloadRequest =
  | { readonly kind: "start"; readonly method: "POST"; readonly path: string }
  | {
      readonly kind: "poll" | "chunk";
      readonly method: "GET";
      readonly path: string;
    };

export class GenieDownloadError extends Data.TaggedError("GenieDownloadError")<{
  readonly message: string;
}> {}

const Download = Schema.Struct({
  download_id: GenieId,
  download_id_signature: Schema.NonEmptyString,
});

const Chunk = Schema.Struct({
  chunk_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  external_link: Schema.NonEmptyString,
  expiration: Schema.optionalKey(Schema.String),
  http_headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const ChunkResult = Schema.Struct({
  external_links: Schema.Array(Chunk),
});

const Statement = Schema.Struct({
  statement_response: Schema.Struct({
    status: Schema.Struct({ state: Schema.String }),
    statement_id: Schema.optionalKey(GenieId),
    manifest: Schema.optionalKey(
      Schema.Struct({
        format: Schema.Literal("CSV"),
        truncated: Schema.Boolean,
        total_chunk_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        schema: Schema.Struct({
          columns: Schema.Array(Schema.Struct({ name: Schema.String })),
        }),
      }),
    ),
    result: Schema.optionalKey(ChunkResult),
  }),
});

const decode = <A>(schema: Schema.Decoder<A>, data: unknown) =>
  Schema.decodeUnknownEffect(schema)(data).pipe(
    Effect.mapError(
      () =>
        new GenieDownloadError({
          message: "Genie returned invalid CSV download details.",
        }),
    ),
  );

const cloudStorage = (hostname: string) =>
  /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com(?:\.cn)?$/.test(hostname) ||
  /\.blob\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/.test(
    hostname,
  ) ||
  hostname === "storage.googleapis.com" ||
  hostname.endsWith(".storage.googleapis.com") ||
  /^[a-z0-9-]+\.storage\.cloud\.databricks\.com$/.test(hostname);

export const makeGenieDownloadClient = <E, R>(options: {
  readonly spaceId: string;
  readonly request: (
    request: GenieDownloadRequest,
  ) => Effect.Effect<unknown, E, R>;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowDatabricksStorageProxy?: boolean;
}) => {
  const fetch = options.fetch ?? globalThis.fetch;
  const request = options.request;
  const paths = chatPaths(options.spaceId);

  const storageUrl = (link: string) =>
    Effect.try({
      try: () => {
        const url = new URL(link);
        const managedProxy =
          options.allowDatabricksStorageProxy &&
          url.hostname === "storage-proxy.databricks.com" &&
          url.protocol === "http:";
        if (
          (!managedProxy &&
            (url.protocol !== "https:" || !cloudStorage(url.hostname))) ||
          url.port ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error();
        return url;
      },
      catch: () =>
        new GenieDownloadError({
          message: "Genie returned an unrecognized CSV storage location.",
        }),
    });

  const storageError = (status?: number) =>
    new GenieDownloadError({
      message:
        status === undefined
          ? "Could not read the Genie CSV from storage."
          : `Genie CSV storage returned HTTP ${status}.`,
    });

  const openChunk = Effect.fnUntraced(
    function* (chunk: typeof Chunk.Type) {
      const url = yield* storageUrl(chunk.external_link);
      const headers = Object.fromEntries(
        Object.entries(chunk.http_headers ?? {}).filter(([name]) =>
          /^x-(?:amz|ms|goog)-/i.test(name),
        ),
      );
      const scope = yield* Scope.fork(yield* Scope.Scope);
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);
      const response = yield* client.get(url, { headers }).pipe(
        Scope.provide(scope),
        Effect.mapError(() => storageError()),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(storageError()),
        }),
      );
      if (response.status !== 200) {
        const body = Option.getOrUndefined(
          HttpClientResponse.toWeb(response),
        )?.body;
        yield* Scope.close(scope, Exit.void);
        if (body)
          yield* Effect.promise(() =>
            body.cancel().catch(() => undefined),
          ).pipe(Effect.timeoutOption("1 second"));
      }
      return { response, scope };
    },
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "omit",
      redirect: "error",
    }),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  );

  const download = (reference: GenieQueryReference) =>
    Effect.gen(function* () {
      const path = `${paths.attachment(reference)}/downloads`;
      const started = yield* request({
        kind: "start",
        method: "POST",
        path,
      }).pipe(Effect.flatMap((data) => decode(Download, data)));
      const pollPath = `${path}/${encodeURIComponent(started.download_id)}?${new URLSearchParams({ download_id_signature: started.download_id_signature }).toString()}`;
      const poll = request({
        kind: "poll",
        method: "GET",
        path: pollPath,
      }).pipe(
        Effect.flatMap((data) => decode(Statement, data)),
        Effect.map((data) => data.statement_response),
      );
      const statement = yield* poll.pipe(
        Effect.repeat({
          while: ({ status }) =>
            status.state === "PENDING" || status.state === "RUNNING",
          schedule: Schedule.spaced("2 seconds"),
        }),
      );

      const manifest = statement.manifest;
      if (
        statement.status.state !== "SUCCEEDED" ||
        !statement.statement_id ||
        !manifest
      )
        return yield* new GenieDownloadError({
          message: "Genie could not prepare the full CSV.",
        });
      if (manifest.truncated)
        return yield* new GenieDownloadError({
          message:
            "Databricks truncated the CSV. Narrow the query and try again.",
        });

      const statementId = statement.statement_id;
      const links = new Map(
        (statement.result?.external_links ?? []).map((chunk) => [
          chunk.chunk_index,
          chunk,
        ]),
      );
      const refreshLink = (index: number) =>
        Effect.gen(function* () {
          const data = yield* request({
            kind: "chunk",
            method: "GET",
            path: `/api/2.0/sql/statements/${encodeURIComponent(statementId)}/result/chunks/${index}`,
          });
          const chunk = (yield* decode(ChunkResult, data)).external_links.find(
            (chunk) => chunk.chunk_index === index,
          );
          if (!chunk)
            return yield* new GenieDownloadError({
              message: "Genie omitted a CSV result chunk.",
            });
          return chunk;
        });

      const readChunk = (index: number) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const cached = links.get(index);
            const expired =
              cached?.expiration !== undefined &&
              Date.parse(cached.expiration) <= (yield* Clock.currentTimeMillis);
            const link =
              !cached || expired ? yield* refreshLink(index) : cached;
            const first = yield* openChunk(link);
            const { response, scope } =
              first.response.status === 401 || first.response.status === 403
                ? yield* openChunk(yield* refreshLink(index))
                : first;
            if (response.status !== 200)
              return yield* storageError(response.status);
            return scopedFetchBody(response, scope).pipe(
              Stream.mapError(() => storageError()),
              Stream.filter((bytes) => bytes.length > 0),
              Stream.timeoutOrElse({
                duration: "30 seconds",
                orElse: () =>
                  Stream.fail(
                    new GenieDownloadError({
                      message: "Genie CSV storage stopped sending data.",
                    }),
                  ),
              }),
            );
          }),
        );

      if (manifest.total_chunk_count === 0) {
        const header = manifest.schema.columns
          .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
          .join(",");
        return Stream.make(new TextEncoder().encode(`${header}\r\n`));
      }

      return Stream.suspend(() => {
        // Databricks writes column names in the first chunk. Subsequent chunks
        // start at a row boundary, but a chunk may omit its final line break.
        let endsWithNewline = true;
        return Stream.range(0, manifest.total_chunk_count - 1).pipe(
          Stream.flatMap((index) => {
            const prefix = endsWithNewline
              ? Stream.empty
              : Stream.make(new TextEncoder().encode("\r\n"));
            return Stream.concat(prefix, readChunk(index)).pipe(
              Stream.tap((bytes) =>
                Effect.sync(() => {
                  endsWithNewline = bytes.at(-1) === 10;
                }),
              ),
            );
          }),
        );
      });
    });
  return { download };
};
