import { Effect, Schema, Stream } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { failure, StatementResponse } from "./protocol.js";

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ChunkInfo = Schema.Struct({
  chunk_index: Schema.optional(Index),
  row_count: Schema.optional(Index),
  row_offset: Schema.optional(Index),
});
const Manifest = Schema.Struct({
  format: Schema.String,
  total_chunk_count: Index,
  total_row_count: Schema.optional(Index),
  truncated: Schema.optional(Schema.Boolean),
  chunks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...ChunkInfo.fields,
        chunk_index: Index,
      }),
    ),
  ),
  schema: Schema.optional(
    Schema.Struct({
      column_count: Schema.optional(Index),
      columns: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            position: Schema.optional(Index),
          }),
        ),
      ),
    }),
  ),
});
export type InlineManifest = typeof Manifest.Type;

const Chunk = Schema.Struct({
  ...ChunkInfo.fields,
  external_links: Schema.optional(Schema.Never),
  data_array: Schema.optional(
    Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
  ),
  next_chunk_index: Schema.optional(Index),
});

const mismatches = (expected: number | undefined, actual: number) =>
  expected !== undefined && expected !== actual;

export const InlineStatementResponse = Schema.Struct({
  ...StatementResponse.fields,
  manifest: Schema.optional(Manifest),
});

const isChunk = Schema.is(Chunk);

interface ChunkExpectation {
  readonly index: number;
  readonly offset?: number | undefined;
  readonly info?: typeof ChunkInfo.Type | undefined;
  readonly width?: number | undefined;
  readonly total?: number | undefined;
  readonly rowLimit?: number | undefined;
  readonly last?: boolean;
}

export const validateChunk = (
  input: unknown,
  { index, offset, info, width, total, rowLimit, last }: ChunkExpectation,
) => {
  if (!isChunk(input))
    return Effect.fail(failure("Invalid inline JSON chunk", "decodeJson"));
  const rows = input.data_array ?? [];
  const expectedOffset = offset ?? info?.row_offset;
  if (
    (input.data_array === undefined &&
      (input.row_count ?? info?.row_count ?? total) !== 0) ||
    mismatches(input.chunk_index, index) ||
    (expectedOffset !== undefined &&
      (mismatches(input.row_offset, expectedOffset) ||
        mismatches(info?.row_offset, expectedOffset))) ||
    mismatches(input.row_count, rows.length) ||
    mismatches(info?.row_count, rows.length) ||
    (input.next_chunk_index !== undefined &&
      (last || input.next_chunk_index !== index + 1))
  ) {
    return Effect.fail(
      failure("Inline JSON chunk does not match result metadata", "decodeJson"),
    );
  }
  const rowOffset = expectedOffset ?? input.row_offset;
  const end = (rowOffset ?? 0) + rows.length;
  const maxRows = total ?? rowLimit;
  if (
    (maxRows !== undefined && end > maxRows) ||
    (last && rowOffset !== undefined && mismatches(total, end))
  ) {
    return Effect.fail(
      failure("Inline JSON row count does not match manifest", "decodeJson"),
    );
  }
  if (width !== undefined && rows.some((row) => row.length !== width)) {
    return Effect.fail(failure("Invalid inline JSON row width", "decodeJson"));
  }
  return Effect.succeed(rows);
};

export const validateFirstPage = (
  { manifest, result }: typeof InlineStatementResponse.Type,
  rowLimit: number,
) =>
  Effect.gen(function* () {
    if (
      !manifest ||
      manifest.format !== "JSON_ARRAY" ||
      (manifest.truncated && manifest.total_row_count !== rowLimit) ||
      (manifest.total_row_count !== undefined &&
        manifest.total_row_count > rowLimit)
    ) {
      return yield* Effect.fail(
        failure(
          "Expected inline JSON results within the row limit",
          "manifest",
        ),
      );
    }
    const count = manifest.total_chunk_count;
    if (count === 0 && mismatches(manifest.total_row_count, 0)) {
      return yield* Effect.fail(
        failure("Missing inline JSON pages", "manifest"),
      );
    }
    if (count === 0 && result === undefined) return { manifest, rows: [] };
    const columns = manifest.schema?.columns;
    const rows = yield* validateChunk(result, {
      index: 0,
      offset: 0,
      info: manifest.chunks?.find((chunk) => chunk.chunk_index === 0),
      width: columns?.length,
      total: count === 0 ? 0 : manifest.total_row_count,
      rowLimit,
      last: count <= 1,
    });
    if (
      (rows.length > 0 && !columns) ||
      (columns &&
        (mismatches(manifest.schema?.column_count, columns.length) ||
          columns.some((column, index) => mismatches(column.position, index))))
    )
      return yield* Effect.fail(
        failure("Invalid inline JSON columns", "manifest"),
      );
    return { manifest, rows };
  });

type Values = ReadonlyArray<string | null>;
export type ProjectRows<Row> = (
  columns: ReadonlyArray<string>,
) => Effect.Effect<
  (rows: ReadonlyArray<Values>) => ReadonlyArray<Row>,
  SqlError
>;

export const namedRows: ProjectRows<Record<string, string | null>> = (
  columns,
) =>
  new Set(columns).size !== columns.length
    ? Effect.fail(failure("Duplicate inline JSON column names", "manifest"))
    : Effect.succeed((rows) =>
        rows.map((row) =>
          Object.fromEntries(
            columns.map((name, index) => [name, row[index] ?? null]),
          ),
        ),
      );

export const positionalRows: ProjectRows<Values> = () =>
  Effect.succeed((rows) => rows);

export const inlineChunks = <Row>(
  meta: InlineManifest | undefined,
  first: unknown,
  fetchChunk: (index: number) => Effect.Effect<unknown, SqlError>,
  project: ProjectRows<Row>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      if (meta?.format !== "JSON_ARRAY") {
        return yield* Effect.fail(
          failure("Expected inline JSON manifest", "manifest"),
        );
      }
      if (meta.truncated) {
        return yield* Effect.fail(
          failure("Truncated inline JSON results", "manifest"),
        );
      }
      if (meta.total_chunk_count === 0) {
        if (mismatches(meta.total_row_count, 0)) {
          return yield* Effect.fail(
            failure("Missing inline JSON chunks", "manifest"),
          );
        }
        return Stream.empty;
      }

      const columns = meta.schema?.columns ?? [];
      if (
        (!meta.schema?.columns && meta.total_row_count !== 0) ||
        mismatches(meta.schema?.column_count, columns.length) ||
        columns.some((column, index) => mismatches(column.position, index))
      ) {
        return yield* Effect.fail(
          failure("Invalid inline JSON columns", "manifest"),
        );
      }
      const projectRows = yield* project(columns.map((column) => column.name));
      const counts = new Map(
        meta.chunks?.map((chunk) => [chunk.chunk_index, chunk]),
      );
      let received = 0;
      const lastIndex = meta.total_chunk_count - 1;
      return Stream.range(0, lastIndex).pipe(
        Stream.mapEffect((index) =>
          Effect.gen(function* () {
            const input =
              index === 0 && first !== undefined
                ? first
                : yield* fetchChunk(index);
            const rows = yield* validateChunk(input, {
              index,
              offset: received,
              info: counts.get(index),
              width: columns.length,
              total: meta.total_row_count,
              last: index === lastIndex,
            });
            received += rows.length;
            return projectRows(rows);
          }),
        ),
      );
    }),
  );
