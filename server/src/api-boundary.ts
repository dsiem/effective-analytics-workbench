import { Effect, Layer, Schema } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import {
  apiErrorCodes,
  ApiNoStore,
  invalidRequestBody,
  RequestValidationErrors,
  serviceErrorSuffixes,
  UpstreamFailureStatus,
} from "@dsiem/analytics-shared/api";
import type { ServiceError } from "./errors.js";

const isUpstreamFailureStatus = Schema.is(UpstreamFailureStatus);
const upstreamStatusFields = (error: ServiceError) =>
  error._tag === "UpstreamError" &&
  isUpstreamFailureStatus(error.upstreamStatus)
    ? { upstreamStatus: error.upstreamStatus }
    : {};

type ErrorBody<Code extends string> = {
  error: { code: Code; message: string; upstreamStatus?: number };
};

type ApiErrorResponse<E extends ServiceError> = E extends {
  readonly _tag: infer Tag extends keyof typeof serviceErrorSuffixes;
  readonly service: infer Service extends string;
}
  ? ErrorBody<`${Service}${(typeof serviceErrorSuffixes)[Tag]}`>
  : E extends { readonly _tag: infer Tag extends keyof typeof apiErrorCodes }
    ? ErrorBody<(typeof apiErrorCodes)[Tag]>
    : never;

function encodeError<E extends ServiceError>(error: E): ApiErrorResponse<E>;
function encodeError(error: ServiceError) {
  return {
    error: {
      code:
        "service" in error
          ? `${error.service}${serviceErrorSuffixes[error._tag]}`
          : apiErrorCodes[error._tag],
      message: error.message,
      ...upstreamStatusFields(error),
    },
  };
}

export const withApiErrors = <A, E extends ServiceError, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) => {
      switch (error._tag) {
        case "OperationTimeout":
          return Effect.logWarning("API dependency timed out", {
            service: error.service,
            errorTag: error._tag,
          });
        case "ServiceUnavailable":
        case "UpstreamError":
          return Effect.logError("API dependency failed", {
            service: error.service,
            errorTag: error._tag,
            ...upstreamStatusFields(error),
          });
        default:
          return Effect.void;
      }
    }),
    Effect.mapError(encodeError<E>),
  );

export const RequestValidationErrorsLive =
  HttpApiMiddleware.layerSchemaErrorTransform(
    RequestValidationErrors,
    (error) =>
      error.kind === "Body" || error.kind === "ResponseHeaders"
        ? Effect.fail(error)
        : Effect.fail(invalidRequestBody()),
  );

export const ApiNoStoreLive = Layer.succeed(ApiNoStore, (effect) =>
  HttpEffect.withPreResponseHandler(effect, (_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeader(response, "Cache-Control", "no-store"),
    ),
  ),
);
