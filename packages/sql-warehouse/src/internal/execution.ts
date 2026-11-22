import {
  RecordBatchReader,
  type Schema as ArrowSchema,
  Table,
  util,
} from "apache-arrow";
import { Effect, Schema, Stream } from "effect";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";
import type { DatabricksClientConfig } from "../DatabricksClient.js";
import {
  afterSubmission,
  ArrowStatementResponse,
  failure,
  httpFailure,
  parameter,
  ResultChunk,
  StatementHandle,
  StatementResponse,
  UnsupportedSqlFragment,
  statementFailure,
  timeout,
} from "./protocol.js";
import {
  inlineChunks,
  InlineStatementResponse,
  namedRows,
  positionalRows,
  validateChunk,
  validateFirstPage,
  type ProjectRows,
} from "./inline.js";
import { makeTransport } from "./transport.js";

const decode = <A>(schema: Schema.Decoder<A>, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => failure("Invalid Databricks API response", "decode")),
  );

const isRunning = ({ status }: StatementHandle) =>
  status.state === "PENDING" || status.state === "RUNNING";

export const makeExecution = (options: DatabricksClientConfig) =>
  Effect.gen(function* () {
    const { config, requestJson, download, withQueryTimeout } =
      yield* makeTransport(options);
    const runStatement = <Response extends StatementResponse, A>(
      sql: string,
      params: ReadonlyArray<unknown>,
      format: "ARROW_STREAM" | "JSON_ARRAY",
      schema: Schema.Decoder<Response>,
      read: (
        response: Response,
        fetchChunk: (index: number) => Effect.Effect<unknown, SqlError>,
      ) => Stream.Stream<A, SqlError>,
      limits: { maxBytes?: number | undefined; rowLimit?: number } = {},
    ) =>
      Stream.suspend(() => {
        const { maxBytes, rowLimit } = limits;
        let statementId: StatementHandle["statement_id"] | undefined;
        return Stream.unwrap(
          Effect.gen(function* () {
            if (
              maxBytes !== undefined &&
              (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
            )
              return yield* Effect.fail(
                failure(
                  "maxBytes must be a positive safe integer",
                  "configure",
                ),
              );
            if (
              rowLimit !== undefined &&
              (!Number.isSafeInteger(rowLimit) || rowLimit <= 0)
            ) {
              return yield* Effect.fail(
                failure(
                  "rowLimit must be a positive safe integer",
                  "configure",
                ),
              );
            }
            const parameters = yield* Effect.try({
              try: () => params.map(parameter),
              catch: (cause) =>
                cause instanceof UnsupportedSqlFragment
                  ? failure(cause.message, "compile")
                  : failure(
                      "Unsupported SQL parameter; use sql.param for an explicit type",
                      "bind",
                    ),
            });
            const query = yield* Effect.acquireRelease(
              requestJson("/api/2.0/sql/statements", "submit", {
                warehouse_id: options.warehouseId,
                statement: sql,
                parameters,
                format,
                disposition:
                  format === "JSON_ARRAY" ? "INLINE" : "EXTERNAL_LINKS",
                wait_timeout: "0s",
                ...(rowLimit === undefined ? {} : { row_limit: rowLimit }),
                ...(options.catalog === undefined
                  ? {}
                  : { catalog: options.catalog }),
                ...(options.schema === undefined
                  ? {}
                  : { schema: options.schema }),
                ...(options.byteLimit === undefined && maxBytes === undefined
                  ? {}
                  : {
                      byte_limit: Math.min(
                        options.byteLimit ?? Infinity,
                        maxBytes ?? Infinity,
                      ),
                    }),
              }).pipe(
                Effect.flatMap((response) =>
                  decode(StatementHandle, response).pipe(
                    Effect.map((current) => ({ current, response })),
                  ),
                ),
              ),
              (query) =>
                Effect.suspend(() =>
                  isRunning(query.current)
                    ? requestJson(
                        `/api/2.0/sql/statements/${encodeURIComponent(query.current.statement_id)}/cancel`,
                        "cancel",
                      ).pipe(Effect.timeoutOption("5 seconds"), Effect.ignore)
                    : Effect.void,
                ),
              // A lost response is already an ambiguous outcome. Abort the request
              // promptly instead of shielding submission from the caller's deadline.
              { interruptible: true },
            );
            const id = query.current.statement_id;
            statementId = id;
            yield* Effect.annotateCurrentSpan("databricks.statement.id", id);
            const path = `/api/2.0/sql/statements/${encodeURIComponent(id)}`;
            let response = query.response;
            let current = yield* decode(schema, response);
            while (isRunning(query.current)) {
              yield* Effect.sleep(config.poll);
              response = yield* requestJson(path, "poll");
              const next = yield* decode(StatementHandle, response);
              if (next.statement_id !== id) {
                return yield* Effect.fail(
                  failure(
                    "Databricks returned a different statement ID",
                    "poll",
                  ),
                );
              }
              query.current = next;
              current = yield* decode(schema, response);
            }
            if (current.status.state !== "SUCCEEDED") {
              return yield* Effect.fail(statementFailure(current.status));
            }
            return read(current, (index) =>
              requestJson(`${path}/result/chunks/${index}`, "metadata"),
            );
          }),
        ).pipe(
          Stream.interruptWhen(
            Effect.sleep(config.query).pipe(
              Effect.andThen(Effect.fail(afterSubmission(timeout("query")))),
            ),
          ),
          Stream.mapError((error) =>
            statementId === undefined
              ? error
              : afterSubmission(error, statementId),
          ),
          Stream.withSpan("databricks.query"),
        );
      });

    const ipcWithMetadata = (
      sql: string,
      params: ReadonlyArray<unknown>,
      maxBytes?: number,
    ) =>
      runStatement(
        sql,
        params,
        "ARROW_STREAM",
        ArrowStatementResponse,
        (current, fetchChunk) => {
          const manifest = current.manifest;
          if (manifest?.format !== "ARROW_STREAM" || manifest.truncated) {
            return Stream.fail(
              failure(
                "Expected complete, untruncated Arrow results",
                "manifest",
              ),
            );
          }
          const first = current.result;
          const rowCounts = new Map(
            manifest.chunks?.map((chunk) => [
              chunk.chunk_index,
              chunk.row_count,
            ]),
          );
          const chunkLink = (index: number, cached?: ResultChunk) =>
            Effect.gen(function* () {
              const metadata =
                cached ??
                (yield* fetchChunk(index).pipe(
                  Effect.flatMap((value) => decode(ResultChunk, value)),
                ));
              const link = metadata.external_links?.find(
                (link) => link.chunk_index === index,
              );
              if (!link) {
                return yield* Effect.fail(
                  failure("Missing Arrow result chunk", "metadata"),
                );
              }
              return {
                link,
                rowCount:
                  rowCounts.get(index) ??
                  link.row_count ??
                  ((metadata.chunk_index ?? index) === index
                    ? metadata.row_count
                    : undefined),
              };
            });
          if (manifest.total_chunk_count === 0) {
            if (manifest.total_row_count) {
              return Stream.fail(
                failure(
                  "Missing Arrow chunks for a nonempty result",
                  "decodeArrow",
                ),
              );
            }
            return Stream.empty;
          }
          let receivedBytes = 0;
          const lastIndex = manifest.total_chunk_count - 1;
          return Stream.range(0, lastIndex).pipe(
            Stream.mapEffect((index) =>
              Effect.gen(function* () {
                const cached =
                  index === 0 &&
                  first?.external_links?.some((link) => link.chunk_index === 0)
                    ? first
                    : undefined;
                let chunk = yield* chunkLink(index, cached);
                const remaining =
                  maxBytes === undefined ? undefined : maxBytes - receivedBytes;
                let result = yield* download(chunk.link, remaining);
                // Signed URLs can expire while the downstream consumer is paused.
                if (result.status === 401 || result.status === 403) {
                  const refreshed = yield* chunkLink(index);
                  result = yield* download(refreshed.link, remaining);
                  chunk = {
                    link: refreshed.link,
                    rowCount: refreshed.rowCount ?? chunk.rowCount,
                  };
                }
                if (result.status < 200 || result.status >= 300) {
                  return yield* Effect.fail(
                    httpFailure(result.status, "download"),
                  );
                }
                receivedBytes += result.bytes.byteLength;
                return {
                  bytes: result.bytes,
                  expectedRowCount: chunk.rowCount,
                  expectedTotal:
                    index === lastIndex ? manifest.total_row_count : undefined,
                  statementId: current.statement_id,
                };
              }),
            ),
          );
        },
        { maxBytes },
      );
    const jsonRows = <Row>(
      sql: string,
      params: ReadonlyArray<unknown>,
      project: ProjectRows<Row>,
    ) =>
      runStatement(
        sql,
        params,
        "JSON_ARRAY",
        InlineStatementResponse,
        (current, fetchChunk) =>
          inlineChunks(
            current.manifest,
            current.result,
            fetchChunk,
            project,
          ).pipe(Stream.flattenIterable),
      );

    const page = (
      sql: string,
      params: ReadonlyArray<unknown>,
      rowLimit: number,
    ) =>
      runStatement(
        sql,
        params,
        "JSON_ARRAY",
        InlineStatementResponse,
        (current, fetchChunk) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              const { manifest, rows } = yield* validateFirstPage(
                current,
                rowLimit,
              );
              const statementId = current.statement_id;
              const columns = manifest.schema?.columns ?? [];
              const project = yield* namedRows(
                columns.map((column) => column.name),
              );
              const readChunk = (index: number, offset: number) => {
                if (
                  statementId === "." ||
                  statementId === ".." ||
                  !Number.isSafeInteger(index) ||
                  index < 1 ||
                  index >= manifest.total_chunk_count ||
                  !Number.isSafeInteger(offset) ||
                  offset < 0
                )
                  return Effect.fail(
                    failure("Invalid statement or chunk position", "metadata"),
                  );
                return fetchChunk(index).pipe(
                  Effect.flatMap((value) =>
                    validateChunk(value, {
                      index,
                      offset,
                      info: manifest.chunks?.find(
                        (chunk) => chunk.chunk_index === index,
                      ),
                      width: columns.length,
                      total: manifest.total_row_count,
                      rowLimit,
                      last: index + 1 === manifest.total_chunk_count,
                    }),
                  ),
                  Effect.map(project),
                  withQueryTimeout,
                  Effect.mapError((error) =>
                    afterSubmission(error, statementId),
                  ),
                );
              };
              return {
                rows: project(rows),
                pageCount: manifest.total_chunk_count,
                truncated: manifest.truncated ?? false,
                readChunk,
              };
            }),
          ),
        { rowLimit },
      );

    const ipc = (
      sql: string,
      params: ReadonlyArray<unknown>,
      maxBytes?: number,
    ) =>
      ipcWithMetadata(sql, params, maxBytes).pipe(
        Stream.map(({ bytes }) => bytes),
      );
    const chunks = (sql: string, params: ReadonlyArray<unknown>) =>
      ipcWithMetadata(sql, params).pipe(
        Stream.mapAccumEffect(
          (): {
            readonly schema: ArrowSchema | undefined;
            readonly rows: number;
          } => ({ schema: undefined, rows: 0 }),
          (state, { bytes, expectedRowCount, expectedTotal, statementId }) =>
            Effect.gen(function* () {
              const table = yield* Effect.try({
                try: () => {
                  const reader = RecordBatchReader.from(bytes).open();
                  const schema = reader.schema;
                  if (!schema) throw new Error("Missing Arrow IPC schema");
                  return new Table(schema, [...reader]);
                },
                catch: () => failure("Invalid Arrow IPC result", "decodeArrow"),
              });
              if (
                expectedRowCount !== undefined &&
                table.numRows !== expectedRowCount
              )
                return yield* Effect.fail(
                  failure(
                    "Arrow chunk row count does not match result metadata",
                    "decodeArrow",
                  ),
                );
              if (
                state.schema &&
                !util.compareSchemas(state.schema, table.schema)
              )
                return yield* Effect.fail(
                  failure(
                    "Incompatible Arrow schemas across result chunks",
                    "decodeArrow",
                  ),
                );
              const rows = state.rows + table.numRows;
              if (expectedTotal !== undefined && rows !== expectedTotal) {
                return yield* Effect.fail(
                  failure(
                    "Arrow result row count does not match the manifest",
                    "decodeArrow",
                  ),
                );
              }
              return [
                { schema: state.schema ?? table.schema, rows },
                [table],
              ] as const;
            }).pipe(
              Effect.mapError((error) => afterSubmission(error, statementId)),
            ),
        ),
      );
    const collectTable = (source: Stream.Stream<Table, SqlError>) =>
      source.pipe(
        Stream.runCollect,
        Effect.flatMap((tables) =>
          Effect.try({
            try: () => {
              const first = tables[0];
              return first
                ? new Table(
                    first.schema,
                    tables.flatMap((table) => table.batches),
                  )
                : new Table();
            },
            catch: () =>
              failure(
                "Incompatible Arrow schemas across result chunks",
                "decodeArrow",
              ),
          }),
        ),
      );
    const connection: Connection = {
      execute: (sql, params, transform) =>
        jsonRows(sql, params, namedRows).pipe(
          Stream.runCollect,
          Effect.map((rows) => (transform ? transform(rows) : rows)),
        ),
      executeRaw: (sql, params) =>
        Stream.runCollect(jsonRows(sql, params, namedRows)),
      executeStream: (sql, params, transform) => {
        const rows = jsonRows(sql, params, namedRows);
        return transform
          ? rows.pipe(
              Stream.chunks,
              Stream.flatMap((chunk) => Stream.fromArray(transform(chunk))),
            )
          : rows;
      },
      executeValues: (sql, params) =>
        Stream.runCollect(jsonRows(sql, params, positionalRows)),
      executeUnprepared: (sql, params, transform) =>
        connection.execute(sql, params, transform),
      executeValuesUnprepared: (sql, params) =>
        connection.executeValues(sql, params),
    };
    return {
      connection,
      page,
      chunks,
      ipc,
      collectTable,
      withQueryTimeout,
    };
  });
