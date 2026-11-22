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

export class TripNotFound extends Data.TaggedError("TripNotFound")<{
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

export class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly service: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UpstreamError extends Data.TaggedError("UpstreamError")<{
  readonly service: string;
  readonly message: string;
  readonly upstreamStatus?: number;
  readonly upstreamCode?: "FEATURE_DISABLED";
  readonly cause?: unknown;
}> {}

export class OperationTimeout extends Data.TaggedError("OperationTimeout")<{
  readonly service: string;
  readonly message: string;
}> {}

export class GenieFailed extends Data.TaggedError("GenieFailed")<{
  readonly status: string;
  readonly message: string;
}> {}

export type WorkspaceRequestError =
  | PermissionDenied
  | ServiceUnavailable
  | UpstreamError
  | OperationTimeout;

export type ServiceError =
  | InvalidRequest
  | PermissionDenied
  | SavedViewNotFound
  | TripNotFound
  | AnalysisRunNotFound
  | AnalysisReportPending
  | SavedViewConflict
  | ServiceUnavailable
  | UpstreamError
  | OperationTimeout
  | GenieFailed;

export const unavailable = (
  service: string,
  message: string,
  cause?: unknown,
) => new ServiceUnavailable({ service, message, cause });

export const isWorkspacePermissionDenied = (cause: unknown) =>
  cause instanceof UpstreamError && cause.upstreamStatus === 403;

export const permissionDenied = (message: string) =>
  new PermissionDenied({ message });

export const mapWorkspacePermission =
  (message: string) => (error: WorkspaceRequestError) =>
    isWorkspacePermissionDenied(error) ? permissionDenied(message) : error;
