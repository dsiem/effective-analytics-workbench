import { Schema } from "effect";
import {
  collaborationCodes,
  collaborationErrors,
  recordCommentsGroup,
  savedViewsGroup,
} from "@dsiem/analytics/collaboration-http";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/http-api";
import {
  AnalysisRun,
  JobRunIdFromString,
  JobRunReference,
  JobRunSummary,
  AnalysisSubmission,
  RouteReliabilityReport,
} from "./analysis-runs.js";
import { UserIdentity } from "@dsiem/analytics/contracts";
import {
  GenieAgentPath,
  GenieInput,
  GenieModeQuery,
  GenieOperation,
  GeniePath,
  GeniePollProgress,
  GenieQueryPath,
  GenieProgress,
  GenieReply,
} from "./genie.js";
import { GpsSearch, TripMap } from "./map-dataset.js";
import { Overview } from "./overview.js";
import { TripCommentCountSearch, TripCommentSearch } from "./trip-comments.js";
import { Filters } from "./filters.js";
import { DatasetMetadata } from "./dataset.js";
import {
  Trip,
  TripPage,
  TripPageCursor,
  TripSearch,
  TripSummary,
  TripSnapshot,
} from "./trips.js";

export const apiErrorCodes = {
  InvalidRequest: collaborationCodes.InvalidRequest,
  PermissionDenied: collaborationCodes.PermissionDenied,
  SavedViewNotFound: collaborationCodes.SavedViewNotFound,
  TripNotFound: "trip_not_found",
  JobRunNotFound: "analysis_run_not_found",
  JobReportPending: "analysis_report_pending",
  SavedViewConflict: collaborationCodes.SavedViewConflict,
  GenieFailed: "genie_message_unavailable",
  GenieAgentModeUnavailable: "genie_agent_mode_unavailable",
} as const;

export const serviceErrorSuffixes = {
  ServiceUnavailable: "_unavailable",
  UpstreamError: "_request_failed",
  OperationTimeout: "_timeout",
} as const;

const errorBody = <S extends Schema.Top>(code: S, status: number) =>
  Schema.Struct({
    error: Schema.Struct({ code, message: Schema.String }),
  }).pipe(HttpApiSchema.status(status));

const TripNotFoundBody = errorBody(
  Schema.Literal(apiErrorCodes.TripNotFound),
  404,
);
const JobRunNotFoundBody = errorBody(
  Schema.Literal(apiErrorCodes.JobRunNotFound),
  404,
);
const JobReportPendingBody = errorBody(
  Schema.Literal(apiErrorCodes.JobReportPending),
  409,
);
const GenieFailedBody = errorBody(
  Schema.Literal(apiErrorCodes.GenieFailed),
  409,
);
const OtherUnavailableServices = Schema.Literals([
  "analysis",
  "auth",
  "genie",
  "warehouse",
  "workspace",
]);
export type UnavailableService =
  | typeof OtherUnavailableServices.Type
  | "lakebase";

const TimeoutService = Schema.Literals([
  "genie",
  "genie_csv",
  "warehouse",
  "workspace",
]);
export type TimeoutService = typeof TimeoutService.Type;

const UpstreamService = Schema.Literals([
  "analysis",
  "genie",
  "genie_csv",
  "workspace",
]);
export type UpstreamService = typeof UpstreamService.Type;

const AgentModeUnavailableBody = errorBody(
  Schema.Literal(apiErrorCodes.GenieAgentModeUnavailable),
  503,
);
const unavailableBody = <
  const S extends readonly [UnavailableService, ...UnavailableService[]],
>(
  ...services: S
) =>
  errorBody(
    Schema.TemplateLiteral([
      Schema.Literals(services),
      serviceErrorSuffixes.ServiceUnavailable,
    ]),
    503,
  );
export const UpstreamFailureStatus = Schema.Int.check(
  Schema.isBetween({ minimum: 400, maximum: 599 }),
);
const upstreamBody = <
  const S extends readonly [UpstreamService, ...UpstreamService[]],
>(
  ...services: S
) =>
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.TemplateLiteral([
        Schema.Literals(services),
        serviceErrorSuffixes.UpstreamError,
      ]),
      message: Schema.String,
      upstreamStatus: Schema.optionalKey(UpstreamFailureStatus),
    }),
  }).pipe(HttpApiSchema.status(502));
const timeoutBody = <
  const S extends readonly [TimeoutService, ...TimeoutService[]],
>(
  ...services: S
) =>
  errorBody(
    Schema.TemplateLiteral([
      Schema.Literals(services),
      serviceErrorSuffixes.OperationTimeout,
    ]),
    504,
  );
const errors = [
  collaborationErrors.InvalidRequest,
  collaborationErrors.PermissionDenied,
  collaborationErrors.SavedViewNotFound,
  TripNotFoundBody,
  JobRunNotFoundBody,
  JobReportPendingBody,
  collaborationErrors.SavedViewConflict,
  GenieFailedBody,
  AgentModeUnavailableBody,
  collaborationErrors.ServiceUnavailable,
  unavailableBody(...OtherUnavailableServices.literals),
  upstreamBody(...UpstreamService.literals),
  timeoutBody(...TimeoutService.literals),
] as const;
export const ApiError = Schema.Union(errors);

export const invalidRequestBody =
  (): typeof collaborationErrors.InvalidRequest.Type => ({
    error: {
      code: apiErrorCodes.InvalidRequest,
      message: "Check the request fields, dates, and ZIP code.",
    },
  });

export class ApiNoStore extends HttpApiMiddleware.Service<ApiNoStore>()(
  "app/ApiNoStore",
  {},
) {}

export class RequestValidationErrors extends HttpApiMiddleware.Service<RequestValidationErrors>()(
  "app/RequestValidationErrors",
  { error: collaborationErrors.InvalidRequest },
) {}

const warehouseErrors = [
  collaborationErrors.PermissionDenied,
  unavailableBody("warehouse"),
  timeoutBody("warehouse"),
] as const;
const analysisErrors = [
  collaborationErrors.PermissionDenied,
  unavailableBody("analysis", "auth", "workspace"),
  upstreamBody("analysis", "workspace"),
] as const;
const workspaceTimeout = timeoutBody("workspace");
const genieAccessErrors = [
  collaborationErrors.PermissionDenied,
  unavailableBody("auth", "genie", "workspace"),
] as const;
const genieErrors = [
  ...genieAccessErrors,
  upstreamBody("genie", "workspace"),
] as const;
const genieTimeouts = timeoutBody("genie", "workspace");
const GenieAccessHeaders = Schema.Struct({
  "x-genie-access": Schema.optionalKey(Schema.String),
});
export const genieAccessHeaders = (
  grant?: string,
): typeof GenieAccessHeaders.Type =>
  grant === undefined ? {} : { "x-genie-access": grant };

const GenieCsvForm = Schema.Struct({
  grant: Schema.optionalKey(Schema.String),
}).pipe(HttpApiSchema.asFormUrlEncoded());

export const genieCsvHeaders = {
  "content-disposition": 'attachment; filename="genie-results.csv"',
  "x-content-type-options": "nosniff",
} as const;

const GenieCsv = HttpApiSchema.WithHeaders(
  HttpApiSchema.StreamUint8Array({ contentType: "text/csv; charset=utf-8" }),
  Schema.Struct({
    "content-disposition": Schema.Literal(
      genieCsvHeaders["content-disposition"],
    ),
    "x-content-type-options": Schema.Literal(
      genieCsvHeaders["x-content-type-options"],
    ),
  }),
);

export const AppApi = HttpApi.make("taxi")
  .add(
    HttpApiGroup.make("viewer").add(
      HttpApiEndpoint.get("current", "/api/me", {
        success: Schema.NullOr(UserIdentity),
      }),
    ),
    HttpApiGroup.make("analytics").add(
      HttpApiEndpoint.get("metadata", "/api/metadata", {
        success: DatasetMetadata,
        error: warehouseErrors,
      }),
      HttpApiEndpoint.get("overview", "/api/overview", {
        query: Filters,
        success: Overview,
        error: warehouseErrors,
      }).middleware(RequestValidationErrors),
      HttpApiEndpoint.get("trips", "/api/trips", {
        query: TripSearch,
        success: TripPage,
        error: warehouseErrors,
      })
        .middleware(RequestValidationErrors)
        .annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
      HttpApiEndpoint.get("tripPage", "/api/trips/pages/:cursor", {
        params: Schema.Struct({ cursor: TripPageCursor }),
        success: TripPage,
        error: warehouseErrors,
      })
        .middleware(RequestValidationErrors)
        .annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
      HttpApiEndpoint.get("tripDetails", "/api/trip-details", {
        query: Schema.Struct({ tripId: TripSummary.fields.trip_id }),
        success: Trip,
        error: [TripNotFoundBody, ...warehouseErrors],
      })
        .middleware(RequestValidationErrors)
        .annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
      HttpApiEndpoint.get("tripMap", "/api/trip-map", {
        query: GpsSearch,
        success: TripMap,
        error: warehouseErrors,
      }).middleware(RequestValidationErrors),
    ),
    HttpApiGroup.make("analysisRuns").add(
      HttpApiEndpoint.post("submit", "/api/analysis-runs", {
        payload: AnalysisSubmission,
        success: JobRunReference.pipe(HttpApiSchema.status(202)),
        error: [
          collaborationErrors.InvalidRequest,
          ...analysisErrors,
          workspaceTimeout,
        ],
      }).middleware(RequestValidationErrors),
      HttpApiEndpoint.get("list", "/api/analysis-runs", {
        success: Schema.Array(JobRunSummary),
        error: [...analysisErrors, workspaceTimeout],
      }),
      HttpApiEndpoint.get("get", "/api/analysis-runs/:id", {
        params: { id: JobRunIdFromString },
        success: AnalysisRun,
        error: [JobRunNotFoundBody, ...analysisErrors, workspaceTimeout],
      }).middleware(RequestValidationErrors),
      HttpApiEndpoint.get("result", "/api/analysis-runs/:id/result", {
        params: { id: JobRunIdFromString },
        success: RouteReliabilityReport,
        error: [
          JobRunNotFoundBody,
          JobReportPendingBody,
          ...analysisErrors,
          timeoutBody("warehouse", "workspace"),
        ],
      }).middleware(RequestValidationErrors),
    ),
    HttpApiGroup.make("genie")
      .add(
        HttpApiEndpoint.post("submit", "/api/genie", {
          payload: GenieInput,
          headers: GenieAccessHeaders,
          success: GenieOperation,
          error: [AgentModeUnavailableBody, ...genieErrors, genieTimeouts],
        }),
        HttpApiEndpoint.get(
          "poll",
          "/api/genie/:conversationId/messages/:messageId",
          {
            params: GeniePath,
            headers: GenieAccessHeaders,
            query: GenieModeQuery,
            success: GeniePollProgress,
            error: [...genieErrors, workspaceTimeout],
          },
        ),
        HttpApiEndpoint.post(
          "cancel",
          "/api/genie/:conversationId/responses/:responseId/cancel",
          {
            params: GenieAgentPath,
            headers: GenieAccessHeaders,
            success: GenieProgress,
            error: [...genieErrors, workspaceTimeout],
          },
        ),
        HttpApiEndpoint.get(
          "result",
          "/api/genie/:conversationId/messages/:messageId/result",
          {
            params: GeniePath,
            headers: GenieAccessHeaders,
            query: GenieModeQuery,
            success: GenieReply,
            error: [GenieFailedBody, ...genieErrors, genieTimeouts],
          },
        ),
        HttpApiEndpoint.post(
          "downloadCsv",
          "/api/genie/:conversationId/messages/:messageId/attachments/:attachmentId/csv",
          {
            params: GenieQueryPath,
            payload: [GenieCsvForm, Schema.Undefined],
            success: GenieCsv,
            error: [
              ...genieAccessErrors,
              upstreamBody("genie_csv", "workspace"),
              timeoutBody("genie_csv", "workspace"),
            ],
          },
        ),
      )
      .middleware(RequestValidationErrors)
      .annotate(HttpApi.RedactedNames, { headers: ["x-genie-access"] }),
    savedViewsGroup("savedViews", "/api/saved-views", Filters).middleware(
      RequestValidationErrors,
    ),
    recordCommentsGroup("tripComments", {
      path: "/api/trip-comments",
      countsPath: "/api/trip-comment-counts",
      fields: { trip: TripSnapshot },
      search: TripCommentSearch,
      counts: TripCommentCountSearch,
    }).middleware(RequestValidationErrors),
  )
  .middleware(ApiNoStore);
