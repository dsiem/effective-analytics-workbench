import { Data, Effect, Schema } from "effect";
import type { GenieAttachment } from "./answer.js";
import {
  decode,
  GeniePermissionDenied,
  GenieResponseError,
} from "./protocol.js";

export class GenieQueryFailed extends Data.TaggedError("GenieQueryFailed")<{
  readonly attachmentId: string;
  readonly sqlState?: string;
  readonly errorCode?: string;
}> {}

export const GenieQueryUnavailable = Data.TaggedError("GenieQueryUnavailable")<
  { readonly attachmentId: string } & (
    | { readonly state: "pending"; readonly status: "PENDING" | "RUNNING" }
    | { readonly state: "unavailable"; readonly status: "CANCELED" | "CLOSED" }
  )
>;
export type GenieQueryUnavailable = InstanceType<typeof GenieQueryUnavailable>;

export const ChatQueryAttachment = Schema.Struct({
  attachment_id: Schema.String,
  query: Schema.Struct({
    query: Schema.String,
    description: Schema.optionalKey(Schema.String),
  }),
});

const Column = Schema.Struct({
  name: Schema.String,
  type_name: Schema.optionalKey(Schema.String),
  type_text: Schema.optionalKey(Schema.String),
});

const Result = Schema.Struct({
  statement_response: Schema.Struct({
    status: Schema.optionalKey(
      Schema.Struct({
        state: Schema.Literals([
          "PENDING",
          "RUNNING",
          "SUCCEEDED",
          "FAILED",
          "CANCELED",
          "CLOSED",
        ]),
        sql_state: Schema.optionalKey(Schema.String),
        error: Schema.optionalKey(
          Schema.Struct({ error_code: Schema.optionalKey(Schema.String) }),
        ),
      }),
    ),
    manifest: Schema.optionalKey(
      Schema.Struct({
        truncated: Schema.optionalKey(Schema.Boolean),
        total_row_count: Schema.optionalKey(Schema.Number),
        schema: Schema.Struct({ columns: Schema.Array(Column) }),
      }),
    ),
    result: Schema.optionalKey(
      Schema.Struct({
        data_array: Schema.optionalKey(
          Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
        ),
        next_chunk_index: Schema.optionalKey(Schema.Number),
      }),
    ),
  }),
});

export const decodeQueryAttachment = (
  { attachment_id: attachmentId, query }: typeof ChatQueryAttachment.Type,
  response: unknown,
) =>
  Effect.gen(function* () {
    const { statement_response: statement } = yield* decode(Result, response);
    const { status, manifest, result } = statement;
    switch (status?.state) {
      case "PENDING":
      case "RUNNING":
        return yield* new GenieQueryUnavailable({
          attachmentId,
          state: "pending",
          status: status.state,
        });
      case "CANCELED":
      case "CLOSED":
        return yield* new GenieQueryUnavailable({
          attachmentId,
          state: "unavailable",
          status: status.state,
        });
      case "FAILED": {
        const errorCode = status.error?.error_code;
        const sqlState = status.sql_state;
        if (errorCode === "PERMISSION_DENIED" || sqlState?.startsWith("425")) {
          return yield* new GeniePermissionDenied({ source: "query" });
        }
        return yield* new GenieQueryFailed({
          attachmentId,
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(sqlState === undefined ? {} : { sqlState }),
        });
      }
    }
    const rows = result?.data_array;
    if (
      manifest === undefined ||
      (rows === undefined && manifest.total_row_count !== 0)
    ) {
      return yield* new GenieResponseError({
        cause: new Error("Genie returned incomplete inline query results"),
      });
    }
    const totalRowCount = manifest.total_row_count;
    const nextChunkIndex = result?.next_chunk_index;
    return {
      kind: "query",
      attachmentId,
      sql: query.query,
      ...(query.description === undefined
        ? {}
        : { description: query.description }),
      columns: manifest.schema.columns.map((column) => ({
        name: column.name,
        ...(column.type_name === undefined
          ? {}
          : { typeName: column.type_name }),
        ...(column.type_text === undefined
          ? {}
          : { typeText: column.type_text }),
      })),
      rows: rows ?? [],
      truncated: manifest.truncated === true,
      ...(totalRowCount === undefined ? {} : { totalRowCount }),
      ...(nextChunkIndex === undefined ? {} : { nextChunkIndex }),
    } satisfies GenieAttachment;
  });
