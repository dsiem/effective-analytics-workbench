import { isSqlError } from "effect/sql/SqlError";
import { Data } from "effect";

export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly message: string;
}> {}

export class SavedViewNotFound extends Data.TaggedError("SavedViewNotFound")<{
  readonly id: string;
  readonly message: string;
}> {}

export class AnalysisRunNotFound extends Data.TaggedError(
  "AnalysisRunNotFound",
)<{
  readonly message: string;
}> {}

export class AnalysisReportPending extends Data.TaggedError(
  "AnalysisReportPending",
)<{
  readonly message: string;
}> {}

export class SavedViewConflict extends Data.TaggedError("SavedViewConflict")<{
  readonly id: string;
  readonly message: string;
}> {}

export class ServiceUnavailable<
  const S extends string = string,
> extends Data.TaggedError("ServiceUnavailable")<{
  readonly service: S;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UpstreamError<
  const S extends string = string,
> extends Data.TaggedError("UpstreamError")<{
  readonly service: S;
  readonly message: string;
  readonly upstreamStatus?: number;
  readonly upstreamCode?: "FEATURE_DISABLED";
  readonly cause?: unknown;
}> {}

export const unavailable = <const S extends string>(
  service: S,
  message: string,
  cause?: unknown,
) => new ServiceUnavailable({ service, message, cause });

export const isWorkspacePermissionDenied = (cause: unknown) =>
  cause instanceof UpstreamError && cause.upstreamStatus === 403;

export const permissionDenied = (message: string) =>
  new PermissionDenied({ message });

export const mapWorkspacePermission =
  (message: string) =>
  <E>(error: E) =>
    isWorkspacePermissionDenied(error) ? permissionDenied(message) : error;

export const postgresFailure =
  (
    deniedMessage: string,
    unavailableMessage = "Lakebase is unavailable. Check its connection settings.",
  ) =>
  (cause: unknown) => {
    if (cause instanceof PermissionDenied) return cause;
    if (
      (isSqlError(cause) && cause.reason._tag === "AuthorizationError") ||
      isWorkspacePermissionDenied(cause)
    )
      return permissionDenied(deniedMessage);
    return unavailable("lakebase", unavailableMessage, cause);
  };
