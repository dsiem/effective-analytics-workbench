import { Data } from "effect";
import type {
  TimeoutService,
  UnavailableService,
  UpstreamService,
} from "@dsiem/analytics-shared/api";
import {
  InvalidRequest,
  PermissionDenied,
  SavedViewNotFound,
  AnalysisRunNotFound,
  AnalysisReportPending,
  SavedViewConflict,
  UpstreamError,
  ServiceUnavailable,
} from "@dsiem/analytics/errors";
export {
  InvalidRequest,
  PermissionDenied,
  SavedViewNotFound,
  AnalysisRunNotFound,
  AnalysisReportPending,
  SavedViewConflict,
  UpstreamError,
  ServiceUnavailable,
  isWorkspacePermissionDenied,
  mapWorkspacePermission,
  permissionDenied,
  unavailable,
} from "@dsiem/analytics/errors";

export class TripNotFound extends Data.TaggedError("TripNotFound")<{
  readonly message: string;
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
  | ServiceUnavailable<UnavailableService>
  | UpstreamError<UpstreamService>
  | OperationTimeout
  | GenieFailed
  | GenieAgentModeUnavailable;
