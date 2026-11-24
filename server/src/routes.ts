import { Effect, Layer } from "effect";
import {
  HttpEffect,
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import {
  ApiBoundary,
  type ApiError,
  AppApi,
  invalidRequestBody,
} from "../../shared/api.js";
import { makeAnalysisRuns } from "./analysis-runs.js";
import { Analytics } from "./analytics.js";
import { makeCurrentUser } from "./current-user.js";
import { InvalidRequest, type ServiceError } from "./errors.js";
import { Genie } from "./genie.js";
import { makeGenieAccess, type GenieViewerAccess } from "./genie-access.js";
import { SavedViews } from "./saved-views.js";
import { TripComments } from "./trip-comments.js";
import { WebRoutes } from "./web-routes.js";

type ErrorByTag = { [E in ServiceError as E["_tag"]]: E };
type ErrorTag = keyof ErrorByTag;

const body = <const Code extends string>(code: Code, message: string) => ({
  error: { code, message },
});

const errorResponses = {
  InvalidRequest: ({ message }) => body("invalid_request", message),
  PermissionDenied: ({ message }) => body("permission_denied", message),
  SavedViewConflict: ({ message }) => body("saved_view_conflict", message),
  SavedViewNotFound: ({ message }) => body("saved_view_not_found", message),
  TripNotFound: ({ message }) => body("trip_not_found", message),
  AnalysisRunNotFound: ({ message }) => body("analysis_run_not_found", message),
  AnalysisReportPending: ({ message }) =>
    body("analysis_report_pending", message),
  ServiceUnavailable: ({ service, message }) =>
    body(`${service}_unavailable`, message),
  OperationTimeout: ({ service, message }) =>
    body(`${service}_timeout`, message),
  GenieFailed: ({ message }) => body("genie_message_unavailable", message),
  UpstreamError: ({ service, message, upstreamStatus }) => ({
    error: {
      code: `${service}_request_failed` as const,
      message,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    },
  }),
} satisfies { [K in ErrorTag]: (error: ErrorByTag[K]) => typeof ApiError.Type };

const toResponse: {
  [K in ErrorTag]: (
    error: ErrorByTag[K],
  ) => ReturnType<(typeof errorResponses)[K]>;
} = errorResponses;

const encodeError = <K extends ErrorTag>(
  error: ErrorByTag[K] & { readonly _tag: K },
) => toResponse[error._tag](error);

const respond = <A, K extends ErrorTag, R>(
  effect: Effect.Effect<A, ErrorByTag[K] & { readonly _tag: K }, R>,
) =>
  effect.pipe(
    Effect.tapCause((cause) => Effect.logError("API operation failed", cause)),
    Effect.mapError(encodeError<K>),
  );

const BoundaryLive = Layer.succeed(ApiBoundary, (effect) =>
  Effect.gen(function* () {
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(
        HttpServerResponse.setHeader(response, "Cache-Control", "no-store"),
      ),
    );
    return yield* effect.pipe(
      Effect.catch((error) => {
        if (!HttpApiError.HttpApiSchemaError.is(error))
          return Effect.fail(error);
        // Invalid service output is a defect, never a client validation error.
        return ["Params", "Query", "Headers", "Payload"].includes(error.kind)
          ? Effect.succeed(
              HttpServerResponse.jsonUnsafe(invalidRequestBody(), {
                status: 400,
              }),
            )
          : Effect.die(error);
      }),
    );
  }),
);

const tripResponse = (body: Uint8Array) =>
  HttpServerResponse.uint8Array(body, {
    contentType: "application/json",
  });
const compressPage = HttpMiddleware.compression({ algorithms: ["gzip"] });

const ApiLive = HttpApiBuilder.group(AppApi, "app", (handlers) =>
  Effect.gen(function* () {
    const analytics = yield* Analytics;
    const analysisRuns = yield* makeAnalysisRuns;
    const genie = yield* Genie;
    const savedViews = yield* SavedViews;
    const comments = yield* TripComments;
    const currentUser = yield* makeCurrentUser;
    const genieAccess = yield* makeGenieAccess;
    const asGenieViewer = <A, E, R>(
      run: (access: GenieViewerAccess) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const { headers } = yield* HttpServerRequest.HttpServerRequest;
        const access = yield* genieAccess(headers);
        return yield* run(access);
      });
    return handlers
      .handle("currentUser", () =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          currentUser(request.headers),
        ),
      )
      .handle("metadata", () => respond(analytics.metadata))
      .handle("overview", ({ query }) => respond(analytics.overview(query)))
      .handle("trips", ({ query }) =>
        respond(analytics.trips(query)).pipe(
          Effect.map(tripResponse),
          compressPage,
        ),
      )
      .handle("tripPage", ({ params }) =>
        respond(analytics.tripPage(params.cursor)).pipe(
          Effect.map(tripResponse),
          compressPage,
        ),
      )
      .handle("tripDetails", ({ query }) =>
        respond(analytics.tripDetails(query.tripId)),
      )
      .handle("tripMap", ({ query }) => respond(analytics.tripMap(query)))
      .handle("submitAnalysisRun", ({ payload }) =>
        respond(
          Effect.gen(function* () {
            const { headers } = yield* HttpServerRequest.HttpServerRequest;
            const user = yield* currentUser(headers);
            return yield* analysisRuns.submit(payload, user?.name ?? null);
          }),
        ),
      )
      .handle("analysisRuns", () => respond(analysisRuns.list))
      .handle("analysisRun", ({ params }) =>
        respond(analysisRuns.get(params.id)),
      )
      .handle("analysisResult", ({ params }) =>
        respond(analysisRuns.result(params.id)),
      )
      .handle("submitGenie", ({ payload, headers }) =>
        respond(
          asGenieViewer((access) =>
            Effect.gen(function* () {
              if (payload.conversationId)
                yield* access.requireGrant(
                  {
                    conversationId: payload.conversationId,
                    ...(payload.mode === undefined
                      ? {}
                      : { mode: payload.mode }),
                  },
                  headers["x-genie-access"],
                );
              const operation = yield* genie.submit(payload);
              const grant = access.grantFor(operation);
              return {
                ...operation,
                ...(grant === undefined ? {} : { grant }),
              };
            }),
          ),
        ),
      )
      .handle("pollGenie", ({ params, query, headers }) =>
        respond(
          asGenieViewer((access) =>
            Effect.gen(function* () {
              const operation = { ...params, ...query };
              yield* access.requireGrant(operation, headers["x-genie-access"]);
              return yield* genie.poll(operation);
            }),
          ),
        ),
      )
      .handle("cancelGenieAgent", ({ params, headers }) =>
        respond(
          asGenieViewer((access) =>
            Effect.gen(function* () {
              yield* access.requireGrant(
                {
                  conversationId: params.conversationId,
                  mode: "agent",
                },
                headers["x-genie-access"],
              );
              return yield* genie.cancel(params);
            }),
          ),
        ),
      )
      .handle("genieResult", ({ params, query, headers }) =>
        respond(
          asGenieViewer((access) =>
            Effect.gen(function* () {
              const operation = { ...params, ...query };
              const grant = headers["x-genie-access"];
              yield* access.requireGrant(operation, grant);
              const reply = yield* genie.result(operation);
              const replyGrant = access.grantFor(reply);
              return {
                ...reply,
                ...(replyGrant === undefined ? {} : { grant: replyGrant }),
              };
            }),
          ),
        ),
      )
      .handle("downloadGenieCsv", ({ params, payload }) =>
        respond(
          asGenieViewer((access) =>
            Effect.gen(function* () {
              const { headers } = yield* HttpServerRequest.HttpServerRequest;
              const site = headers["sec-fetch-site"];
              if (site !== undefined && site !== "same-origin")
                return yield* new InvalidRequest({
                  message: "Open the query in Genie to export its results.",
                });
              yield* access.requireGrant(params, payload?.grant);
              const csv = yield* genie.downloadCsv(params);
              return HttpServerResponse.stream(csv, {
                contentType: "text/csv; charset=utf-8",
                headers: {
                  "Content-Disposition":
                    'attachment; filename="genie-results.csv"',
                  "X-Content-Type-Options": "nosniff",
                },
              });
            }),
          ),
        ),
      )
      .handle("savedViews", ({ query }) => respond(savedViews.list(query)))
      .handle("tripComments", ({ query }) => respond(comments.list(query)))
      .handle("tripCommentCounts", ({ query }) =>
        respond(comments.counts(query)),
      )
      .handle("addTripComment", ({ payload }) =>
        respond(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const author = yield* currentUser(request.headers);
            return yield* comments.add(payload, author);
          }),
        ),
      )
      .handle("saveSavedView", ({ payload }) =>
        respond(savedViews.save(payload)),
      )
      .handle("pinSavedView", ({ params, payload }) =>
        respond(savedViews.pin(params.id, payload)),
      )
      .handle("removeSavedView", ({ params, query }) =>
        respond(
          savedViews
            .remove(params.id, query.version)
            .pipe(Effect.as({ deleted: true as const })),
        ),
      );
  }),
).pipe(Layer.provide(BoundaryLive));

export const Routes = Layer.merge(
  HttpApiBuilder.layer(AppApi).pipe(Layer.provide(ApiLive)),
  WebRoutes,
);
