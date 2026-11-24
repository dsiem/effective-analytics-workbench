import { Effect, Layer, Schema } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiError } from "effect/http-api";
import {
  ApiBoundary,
  apiErrorCodes,
  invalidRequestBody,
  serviceErrorSuffixes,
  UpstreamFailureStatus,
} from "../../shared/api.js";
import type { ServiceError } from "./errors.js";

const isUpstreamFailureStatus = Schema.is(UpstreamFailureStatus);

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
      ...(error._tag === "UpstreamError" &&
      isUpstreamFailureStatus(error.upstreamStatus)
        ? { upstreamStatus: error.upstreamStatus }
        : {}),
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
          return Effect.logWarning("API dependency timed out", error);
        case "ServiceUnavailable":
        case "UpstreamError":
          return Effect.logError("API dependency failed", error);
        default:
          return Effect.void;
      }
    }),
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
