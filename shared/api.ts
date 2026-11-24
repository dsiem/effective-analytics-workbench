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

export const apiErrorCodes = {
  InvalidRequest: "invalid_request",
  PermissionDenied: "permission_denied",
  SavedViewNotFound: "saved_view_not_found",
  TripNotFound: "trip_not_found",
  AnalysisRunNotFound: "analysis_run_not_found",
  AnalysisReportPending: "analysis_report_pending",
  SavedViewConflict: "saved_view_conflict",
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

export const InvalidRequestBody = errorBody(
  Schema.Literal(apiErrorCodes.InvalidRequest),
  400,
);
const NotFoundBody = errorBody(
  Schema.Literal(apiErrorCodes.SavedViewNotFound),
  404,
);
const TripNotFoundBody = errorBody(
  Schema.Literal(apiErrorCodes.TripNotFound),
  404,
);
export const PermissionDeniedBody = errorBody(
  Schema.Literal(apiErrorCodes.PermissionDenied),
  403,
);
const AnalysisRunNotFoundBody = errorBody(
  Schema.Literal(apiErrorCodes.AnalysisRunNotFound),
  404,
);
const AnalysisReportPendingBody = errorBody(
  Schema.Literal(apiErrorCodes.AnalysisReportPending),
  409,
);
const SavedViewConflictBody = errorBody(
  Schema.Literal(apiErrorCodes.SavedViewConflict),
  409,
);
const GenieFailedBody = errorBody(
  Schema.Literal(apiErrorCodes.GenieFailed),
  409,
);
const UnavailableService = Schema.Literals([
  "analysis",
  "auth",
  "genie",
  "lakebase",
  "warehouse",
  "workspace",
]);
export type UnavailableService = typeof UnavailableService.Type;

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
  InvalidRequestBody,
  PermissionDeniedBody,
  NotFoundBody,
  TripNotFoundBody,
  AnalysisRunNotFoundBody,
  AnalysisReportPendingBody,
  SavedViewConflictBody,
  GenieFailedBody,
  AgentModeUnavailableBody,
  unavailableBody(...UnavailableService.literals),
  upstreamBody(...UpstreamService.literals),
  timeoutBody(...TimeoutService.literals),
] as const;
export const ApiError = Schema.Union(errors);

export const invalidRequestBody = (): typeof InvalidRequestBody.Type => ({
  error: {
    code: apiErrorCodes.InvalidRequest,
    message: "Check the request fields, dates, and ZIP code.",
  },
});

export class ApiBoundary extends HttpApiMiddleware.Service<ApiBoundary>()(
  "app/ApiBoundary",
  {},
) {}

const warehouseErrors = [
  PermissionDeniedBody,
  unavailableBody("warehouse"),
  timeoutBody("warehouse"),
] as const;
const analysisErrors = [
  PermissionDeniedBody,
  unavailableBody("analysis", "auth", "workspace"),
  upstreamBody("analysis", "workspace"),
] as const;
const workspaceTimeout = timeoutBody("workspace");
const genieAccessErrors = [
  PermissionDeniedBody,
  unavailableBody("auth", "genie", "workspace"),
] as const;
const genieErrors = [
  ...genieAccessErrors,
  upstreamBody("genie", "workspace"),
] as const;
const genieTimeouts = timeoutBody("genie", "workspace");
const lakebaseErrors = [
  InvalidRequestBody,
  PermissionDeniedBody,
  unavailableBody("lakebase"),
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
        success: Schema.NullOr(CurrentUser),
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
    ),
    HttpApiGroup.make("analysisRuns").add(
      HttpApiEndpoint.post("submit", "/api/analysis-runs", {
        payload: AnalysisSubmission,
        success: AnalysisRunReference.pipe(HttpApiSchema.status(202)),
        error: [InvalidRequestBody, ...analysisErrors, workspaceTimeout],
      }),
      HttpApiEndpoint.get("list", "/api/analysis-runs", {
        success: Schema.Array(AnalysisRunSummary),
        error: [...analysisErrors, workspaceTimeout],
      }),
      HttpApiEndpoint.get("get", "/api/analysis-runs/:id", {
        params: { id: AnalysisRunIdFromString },
        success: AnalysisRun,
        error: [
          InvalidRequestBody,
          AnalysisRunNotFoundBody,
          ...analysisErrors,
          workspaceTimeout,
        ],
      }),
      HttpApiEndpoint.get("result", "/api/analysis-runs/:id/result", {
        params: { id: AnalysisRunIdFromString },
        success: RouteReliabilityReport,
        error: [
          InvalidRequestBody,
          AnalysisRunNotFoundBody,
          AnalysisReportPendingBody,
          ...analysisErrors,
          timeoutBody("warehouse", "workspace"),
        ],
      }),
    ),
    HttpApiGroup.make("genie")
      .add(
        HttpApiEndpoint.post("submit", "/api/genie", {
          payload: GenieInput,
          headers: GenieAccessHeaders,
          success: GenieOperation,
          error: [
            InvalidRequestBody,
            AgentModeUnavailableBody,
            ...genieErrors,
            genieTimeouts,
          ],
        }),
        HttpApiEndpoint.get(
          "poll",
          "/api/genie/:conversationId/messages/:messageId",
          {
            params: GeniePath,
            headers: GenieAccessHeaders,
            query: GenieModeQuery,
            success: GeniePollProgress,
            error: [InvalidRequestBody, ...genieErrors, workspaceTimeout],
          },
        ),
        HttpApiEndpoint.post(
          "cancel",
          "/api/genie/:conversationId/responses/:responseId/cancel",
          {
            params: GenieAgentPath,
            headers: GenieAccessHeaders,
            success: GenieProgress,
            error: [InvalidRequestBody, ...genieErrors, workspaceTimeout],
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
            error: [
              InvalidRequestBody,
              GenieFailedBody,
              ...genieErrors,
              genieTimeouts,
            ],
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
              InvalidRequestBody,
              ...genieAccessErrors,
              upstreamBody("genie_csv", "workspace"),
              timeoutBody("genie_csv", "workspace"),
            ],
          },
        ),
      )
      .annotate(HttpApi.RedactedNames, { headers: ["x-genie-access"] }),
    HttpApiGroup.make("savedViews").add(
      HttpApiEndpoint.get("list", "/api/saved-views", {
        query: SavedViewSearch,
        success: SavedViewsPage,
        error: lakebaseErrors,
      }),
      HttpApiEndpoint.put("save", "/api/saved-views", {
        payload: SavedViewInput,
        success: SavedView,
        error: savedViewWriteErrors,
      }),
      HttpApiEndpoint.patch("pin", "/api/saved-views/:id/pin", {
        params: { id: SavedViewInput.fields.id },
        payload: SavedViewPin,
        success: SavedView,
        error: savedViewWriteErrors,
      }),
      HttpApiEndpoint.delete("remove", "/api/saved-views/:id", {
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
    ),
    HttpApiGroup.make("tripComments").add(
      HttpApiEndpoint.get("list", "/api/trip-comments", {
        query: TripCommentSearch,
        success: TripComments,
        error: lakebaseErrors,
      }).annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
      HttpApiEndpoint.get("counts", "/api/trip-comment-counts", {
        query: TripCommentCountSearch,
        success: TripCommentCounts,
        error: lakebaseErrors,
      }),
      HttpApiEndpoint.post("add", "/api/trip-comments", {
        payload: TripCommentInput,
        success: TripComment,
        error: lakebaseErrors,
      }),
    ),
  )
  .middleware(ApiBoundary);
