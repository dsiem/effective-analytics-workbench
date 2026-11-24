import { Data } from "effect";
import type {
  TimeoutService,
  UnavailableService,
  UpstreamService,
} from "../../shared/api.js";

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

export class ServiceUnavailable<
  const S extends UnavailableService = UnavailableService,
> extends Data.TaggedError("ServiceUnavailable")<{
  readonly service: S;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UpstreamError<
  const S extends UpstreamService = UpstreamService,
> extends Data.TaggedError("UpstreamError")<{
  readonly service: S;
  readonly message: string;
  readonly upstreamStatus?: number;
  readonly upstreamCode?: "FEATURE_DISABLED";
  readonly cause?: unknown;
}> {}

export class OperationTimeout<
  const S extends TimeoutService = TimeoutService,
> extends Data.TaggedError("OperationTimeout")<{
  readonly service: S;
  readonly message: string;
}> {}

export class GenieAgentModeUnavailable extends Data.TaggedError(
  "GenieAgentModeUnavailable",
)<{
  readonly message: string;
}> {}

export class GenieFailed extends Data.TaggedError("GenieFailed")<{
  readonly status: string;
  readonly message: string;
}> {}

export type WorkspaceRequestError =
  | PermissionDenied
  | ServiceUnavailable<"auth" | "workspace">
  | UpstreamError<"workspace">
  | OperationTimeout<"workspace">;

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
  | GenieFailed
  | GenieAgentModeUnavailable;

export const unavailable = <const S extends UnavailableService>(
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
  <E extends ServiceError>(error: E) =>
    isWorkspacePermissionDenied(error) ? permissionDenied(message) : error;
