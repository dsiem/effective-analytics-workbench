import { Effect, Layer } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiError } from "effect/http-api";
import {
  ApiBoundary,
  invalidRequestBody,
  type ApiError,
} from "../../shared/api.js";
import type { ServiceError } from "./errors.js";

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

function encodeError<E extends ServiceError>(
  error: E,
): ReturnType<(typeof errorResponses)[E["_tag"]]>;
function encodeError<K extends ErrorTag>(
  error: ErrorByTag[K] & { readonly _tag: K },
) {
  return toResponse[error._tag](error);
}

export const withApiErrors = <A, E extends ServiceError, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapCause((cause) => Effect.logError("API operation failed", cause)),
    Effect.mapError(encodeError<E>),
  );

export const ApiBoundaryLive = Layer.succeed(ApiBoundary, (effect) =>
  effect.pipe(
    Effect.catch((error) => {
      if (!HttpApiError.HttpApiSchemaError.is(error)) return Effect.fail(error);

      switch (error.kind) {
        case "Params":
        case "Query":
        case "Headers":
        case "Payload":
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(invalidRequestBody(), {
              status: 400,
            }),
          );
        case "Body":
        case "ResponseHeaders":
          return Effect.die(error);
      }
    }),
    HttpEffect.withPreResponseHandler((_request, response) =>
      Effect.succeed(
        HttpServerResponse.setHeader(response, "Cache-Control", "no-store"),
      ),
    ),
  ),
);
