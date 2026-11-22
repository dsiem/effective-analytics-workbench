import { Schema } from "effect";
import * as Statement from "effect/sql/Statement";
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  SqlError,
  SqlErrorReason,
  SqlSyntaxError,
  StatementTimeoutError,
  UnknownError,
} from "effect/sql/SqlError";

// Projection of the documented Statement Execution API response. Unknown fields
// are intentionally ignored so additive server changes do not break the driver.
// https://docs.databricks.com/api/statement-execution/v1/statement-execution
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StatementId = Schema.NonEmptyString.pipe(
  Schema.brand("DatabricksStatementId"),
);
const ExternalLink = Schema.Struct({
  chunk_index: Index,
  row_count: Schema.optional(Index),
  external_link: Schema.NonEmptyString,
  http_headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ExternalLink = typeof ExternalLink.Type;
export const ResultChunk = Schema.Struct({
  chunk_index: Schema.optional(Index),
  row_count: Schema.optional(Index),
  external_links: Schema.optional(Schema.Array(ExternalLink)),
});
export const StatementHandle = Schema.Struct({
  statement_id: StatementId,
  status: Schema.Struct({
    state: Schema.Literals([
      "PENDING",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "CANCELED",
      "CLOSED",
    ]),
  }),
});
export type StatementHandle = typeof StatementHandle.Type;

export const StatementResponse = Schema.Struct({
  ...StatementHandle.fields,
  status: Schema.Struct({
    ...StatementHandle.fields.status.fields,
    error: Schema.optional(
      Schema.Struct({
        error_code: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
    ),
    sql_state: Schema.optional(Schema.String),
  }),
  manifest: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
});
export type StatementResponse = typeof StatementResponse.Type;

export const ArrowStatementResponse = Schema.Struct({
  ...StatementResponse.fields,
  manifest: Schema.optional(
    Schema.Struct({
      format: Schema.String,
      total_chunk_count: Index,
      total_row_count: Schema.optional(Index),
      truncated: Schema.optional(Schema.Boolean),
      chunks: Schema.optional(
        Schema.Array(
          Schema.Struct({
            chunk_index: Index,
            row_count: Schema.optional(Index),
          }),
        ),
      ),
    }),
  ),
  result: Schema.optional(ResultChunk),
});

export type ResultChunk = typeof ResultChunk.Type;

export const failure = (message: string, operation: string) =>
  new SqlError({
    reason: new UnknownError({ cause: undefined, message, operation }),
  });

const hasOriginalReason = Schema.is(
  Schema.Struct({
    reason: Schema.Literals(
      SqlErrorReason.members.map((member) => member.fields._tag.schema.literal),
    ),
  }),
);
const decodeSqlErrorReason = Schema.decodeUnknownSync(SqlErrorReason);

export const afterSubmission = (
  error: SqlError,
  statementId?: typeof StatementId.Type,
): SqlError => {
  // A write may have committed. Use a nonretryable tag that survives serialization.
  if (error.isRetryable) {
    return new SqlError({
      reason: new UnknownError({
        cause: {
          reason: error.reason._tag,
          ...(statementId === undefined ? {} : { statementId }),
        },
        operation: error.reason.operation,
        message: `${error.message}. Check the statement outcome before resubmitting.`,
      }),
    });
  }
  if (statementId === undefined) return error;
  const previous = error.reason.cause;
  return new SqlError({
    reason: decodeSqlErrorReason({
      _tag: error.reason._tag,
      message: error.reason.message,
      operation: error.reason.operation,
      ...(error.reason._tag === "UniqueViolation"
        ? { constraint: error.reason.constraint }
        : {}),
      cause: {
        statementId,
        ...(hasOriginalReason(previous) ? { reason: previous.reason } : {}),
      },
    }),
  });
};

export const timeout = (operation: string) =>
  new SqlError({
    reason: new StatementTimeoutError({
      cause: undefined,
      message: `Databricks ${operation} timed out`,
      operation,
    }),
  });

export const httpFailure = (status: number, operation: string) => {
  const props = {
    cause: undefined,
    message: `Databricks ${operation} returned HTTP ${status}`,
    operation,
  };
  return new SqlError({
    reason:
      status === 401
        ? new AuthenticationError(props)
        : status === 403
          ? new AuthorizationError(props)
          : status === 408 || status === 504
            ? new StatementTimeoutError(props)
            : status === 429 || status >= 500
              ? new ConnectionError(props)
              : new UnknownError(props),
  });
};

export const statementFailure = (status: StatementResponse["status"]) => {
  const props = {
    cause: undefined,
    message: status.error?.message ?? `Databricks statement ${status.state}`,
    operation: "execute",
  };
  const code = status.error?.error_code;
  return new SqlError({
    reason:
      code === "UNAUTHENTICATED"
        ? new AuthenticationError(props)
        : code === "PERMISSION_DENIED" || status.sql_state?.startsWith("425")
          ? new AuthorizationError(props)
          : status.sql_state?.startsWith("42")
            ? new SqlSyntaxError(props)
            : code === "DEADLINE_EXCEEDED"
              ? new StatementTimeoutError(props)
              : new UnknownError(props),
  });
};

/** Permit HTTP only for local development; never embed credentials in URLs. */
export const parseUrl = (
  value: string,
  allowDatabricksStorageProxy = false,
): URL => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const managedProxy =
    allowDatabricksStorageProxy &&
    url.hostname === "storage-proxy.databricks.com" &&
    !url.port;
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (loopback || managedProxy))) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "Expected HTTPS URL without embedded credentials or fragment",
    );
  }
  return url;
};

export class UnsupportedSqlFragment extends Error {}

export class TypedParameter {
  constructor(
    readonly type: string,
    readonly value: string | null,
  ) {}
}

export const parameter = (input: unknown, index: number) => {
  // IN lists retain the fragment, while templates and record helpers pass its value.
  const segment =
    Statement.isFragment(input) && input.segments.length === 1
      ? input.segments[0]
      : undefined;
  const value = segment?._tag === "Parameter" ? segment.value : input;
  if (value instanceof UnsupportedSqlFragment) throw value;
  const name = `p${index + 1}`;
  if (value instanceof TypedParameter) {
    return { name, type: value.type, value: value.value };
  }
  if (value === null || value === undefined) {
    return { name, type: "STRING", value: null };
  }
  switch (typeof value) {
    case "string":
      return { name, type: "STRING", value };
    case "boolean":
      return { name, type: "BOOLEAN", value: String(value) };
    case "bigint":
      return { name, type: "BIGINT", value: String(value) };
    case "number":
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      ) {
        throw new Error(
          "Use bigint or an explicit typed parameter for large integers",
        );
      }
      return {
        name,
        type: Number.isInteger(value) ? "BIGINT" : "DOUBLE",
        value: String(value),
      };
    default:
      if (value instanceof Date && Number.isFinite(value.getTime())) {
        return { name, type: "TIMESTAMP", value: value.toISOString() };
      }
      throw new Error(
        "Unsupported Databricks parameter; use sql.param(type, stringValue)",
      );
  }
};
