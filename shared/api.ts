import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/http-api";
import {
  AnalysisRun,
  AnalysisRunIdFromString,
  AnalysisRunReference,
  AnalysisRunSummary,
  AnalysisSubmission,
  RouteReliabilityReport,
} from "./analysis-runs.js";
import { CurrentUser } from "./current-user.js";
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
import {
  SavedView,
  SavedViewInput,
  SavedViewPin,
  SavedViewSearch,
  SavedViewsPage,
} from "./saved-views.js";
import {
  TripComment,
  TripCommentCountSearch,
  TripCommentCounts,
  TripCommentInput,
  TripCommentSearch,
  TripComments,
} from "./trip-comments.js";
import { Filters } from "./filters.js";
import { DatasetMetadata } from "./dataset.js";
import {
  Trip,
  TripPage,
  TripPageCursor,
  TripSearch,
  TripSummary,
} from "./trips.js";

const errorBody = <S extends Schema.Top>(code: S, status: number) =>
  Schema.Struct({
    error: Schema.Struct({ code, message: Schema.String }),
  }).pipe(HttpApiSchema.status(status));

export const InvalidRequestBody = errorBody(
  Schema.Literal("invalid_request"),
  400,
);
const NotFoundBody = errorBody(Schema.Literal("saved_view_not_found"), 404);
const TripNotFoundBody = errorBody(Schema.Literal("trip_not_found"), 404);
export const PermissionDeniedBody = errorBody(
  Schema.Literal("permission_denied"),
  403,
);
const AnalysisRunNotFoundBody = errorBody(
  Schema.Literal("analysis_run_not_found"),
  404,
);
const AnalysisReportPendingBody = errorBody(
  Schema.Literal("analysis_report_pending"),
  409,
);
const SavedViewConflictBody = errorBody(
  Schema.Literal("saved_view_conflict"),
  409,
);
const GenieFailedBody = errorBody(
  Schema.Literal("genie_message_unavailable"),
  409,
);
const UnavailableBody = errorBody(
  Schema.TemplateLiteral([Schema.String, "_unavailable"]),
  503,
);
const UpstreamBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.TemplateLiteral([Schema.String, "_request_failed"]),
    message: Schema.String,
    upstreamStatus: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
    ),
  }),
}).pipe(HttpApiSchema.status(502));
const TimeoutBody = errorBody(
  Schema.TemplateLiteral([Schema.String, "_timeout"]),
  504,
);
const errors = [
  InvalidRequestBody,
  PermissionDeniedBody,
  NotFoundBody,
  TripNotFoundBody,
  AnalysisRunNotFoundBody,
  AnalysisReportPendingBody,
  SavedViewConflictBody,
  GenieFailedBody,
  UnavailableBody,
  UpstreamBody,
  TimeoutBody,
] as const;
export const ApiError = Schema.Union(errors);

export const invalidRequestBody = (): typeof InvalidRequestBody.Type => ({
  error: {
    code: "invalid_request",
    message: "Check the request fields, dates, and ZIP code.",
  },
});

// Server-only middleware implementation lives at the HTTP boundary in routes.ts.
export class ApiBoundary extends HttpApiMiddleware.Service<ApiBoundary>()(
  "app/ApiBoundary",
  {},
) {}

const warehouseErrors = [
  PermissionDeniedBody,
  UnavailableBody,
  TimeoutBody,
] as const;
const workspaceErrors = [
  PermissionDeniedBody,
  UnavailableBody,
  UpstreamBody,
  TimeoutBody,
] as const;
const lakebaseErrors = [
  InvalidRequestBody,
  PermissionDeniedBody,
  UnavailableBody,
] as const;
const savedViewWriteErrors = [
  ...lakebaseErrors,
  NotFoundBody,
  SavedViewConflictBody,
] as const;

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

export const AppApi = HttpApi.make("taxi").add(
  HttpApiGroup.make("app")
    .add(
      HttpApiEndpoint.get("currentUser", "/api/me", {
        success: Schema.NullOr(CurrentUser),
      }),
      HttpApiEndpoint.get("metadata", "/api/metadata", {
        success: DatasetMetadata,
        error: warehouseErrors,
      }),
      HttpApiEndpoint.get("overview", "/api/overview", {
        query: Filters,
        success: Overview,
        error: [InvalidRequestBody, ...warehouseErrors],
      }),
      HttpApiEndpoint.get("trips", "/api/trips", {
        query: TripSearch,
        success: TripPage,
        error: [InvalidRequestBody, ...warehouseErrors],
      }).annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
      HttpApiEndpoint.get("tripPage", "/api/trips/pages/:cursor", {
        params: Schema.Struct({ cursor: TripPageCursor }),
        success: TripPage,
        error: [InvalidRequestBody, ...warehouseErrors],
      }).annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
      HttpApiEndpoint.get("tripDetails", "/api/trip-details", {
        query: Schema.Struct({ tripId: TripSummary.fields.trip_id }),
        success: Trip,
        error: [InvalidRequestBody, TripNotFoundBody, ...warehouseErrors],
      }).annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
      HttpApiEndpoint.get("tripMap", "/api/trip-map", {
        query: GpsSearch,
        success: TripMap,
        error: [InvalidRequestBody, ...warehouseErrors],
      }),
      HttpApiEndpoint.post("submitAnalysisRun", "/api/analysis-runs", {
        payload: AnalysisSubmission,
        success: AnalysisRunReference.pipe(HttpApiSchema.status(202)),
        error: [InvalidRequestBody, ...workspaceErrors],
      }),
      HttpApiEndpoint.get("analysisRuns", "/api/analysis-runs", {
        success: Schema.Array(AnalysisRunSummary),
        error: workspaceErrors,
      }),
      HttpApiEndpoint.get("analysisRun", "/api/analysis-runs/:id", {
        params: { id: AnalysisRunIdFromString },
        success: AnalysisRun,
        error: [
          InvalidRequestBody,
          AnalysisRunNotFoundBody,
          ...workspaceErrors,
        ],
      }),
      HttpApiEndpoint.get("analysisResult", "/api/analysis-runs/:id/result", {
        params: { id: AnalysisRunIdFromString },
        success: RouteReliabilityReport,
        error: [
          InvalidRequestBody,
          AnalysisRunNotFoundBody,
          AnalysisReportPendingBody,
          ...workspaceErrors,
        ],
      }),
      HttpApiEndpoint.post("submitGenie", "/api/genie", {
        payload: GenieInput,
        headers: GenieAccessHeaders,
        success: GenieOperation,
        error: [InvalidRequestBody, ...workspaceErrors],
      }),
      HttpApiEndpoint.get(
        "pollGenie",
        "/api/genie/:conversationId/messages/:messageId",
        {
          params: GeniePath,
          headers: GenieAccessHeaders,
          query: GenieModeQuery,
          success: GeniePollProgress,
          error: [InvalidRequestBody, ...workspaceErrors],
        },
      ),
      HttpApiEndpoint.post(
        "cancelGenieAgent",
        "/api/genie/:conversationId/responses/:responseId/cancel",
        {
          params: GenieAgentPath,
          headers: GenieAccessHeaders,
          success: GenieProgress,
          error: [InvalidRequestBody, ...workspaceErrors],
        },
      ),
      HttpApiEndpoint.get(
        "genieResult",
        "/api/genie/:conversationId/messages/:messageId/result",
        {
          params: GeniePath,
          headers: GenieAccessHeaders,
          query: GenieModeQuery,
          success: GenieReply,
          error: [InvalidRequestBody, GenieFailedBody, ...workspaceErrors],
        },
      ),
      HttpApiEndpoint.post(
        "downloadGenieCsv",
        "/api/genie/:conversationId/messages/:messageId/attachments/:attachmentId/csv",
        {
          params: GenieQueryPath,
          payload: [GenieCsvForm, Schema.Undefined],
          success: HttpApiSchema.StreamUint8Array({ contentType: "text/csv" }),
          error: [InvalidRequestBody, ...workspaceErrors],
        },
      ),
      HttpApiEndpoint.get("savedViews", "/api/saved-views", {
        query: SavedViewSearch,
        success: SavedViewsPage,
        error: lakebaseErrors,
      }),
      HttpApiEndpoint.get("tripComments", "/api/trip-comments", {
        query: TripCommentSearch,
        success: TripComments,
        error: lakebaseErrors,
      }).annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
      HttpApiEndpoint.get("tripCommentCounts", "/api/trip-comment-counts", {
        query: TripCommentCountSearch,
        success: TripCommentCounts,
        error: lakebaseErrors,
      }),
      HttpApiEndpoint.post("addTripComment", "/api/trip-comments", {
        payload: TripCommentInput,
        success: TripComment,
        error: lakebaseErrors,
      }),
      HttpApiEndpoint.put("saveSavedView", "/api/saved-views", {
        payload: SavedViewInput,
        success: SavedView,
        error: savedViewWriteErrors,
      }),
      HttpApiEndpoint.patch("pinSavedView", "/api/saved-views/:id/pin", {
        params: { id: SavedViewInput.fields.id },
        payload: SavedViewPin,
        success: SavedView,
        error: savedViewWriteErrors,
      }),
      HttpApiEndpoint.delete("removeSavedView", "/api/saved-views/:id", {
        params: { id: SavedViewInput.fields.id },
        query: {
          version: Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isGreaterThan(0),
          ),
        },
        success: Schema.Struct({ deleted: Schema.Literal(true) }),
        error: savedViewWriteErrors,
      }),
    )
    .middleware(ApiBoundary),
);
