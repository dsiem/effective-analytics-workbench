import { Effect, Schema, type Scope } from "effect";
import { ApiError } from "@dsiem/analytics-shared/api";
import { AccessDenied, type Notice } from "./request-state";

export const failure = (cause: unknown): Notice => {
  if (!Schema.is(ApiError)(cause))
    return "Unable to complete the request. Check your connection and retry.";
  const { code, message } = cause.error;
  return code === "permission_denied"
    ? AccessDenied.make({ message })
    : message;
};
// The shared HTTP contract is the only network error boundary.
export const result = <A, E, R>(effect: Effect.Effect<A, E, R | Scope.Scope>) =>
  effect.pipe(
    Effect.scoped,
    Effect.match({
      onSuccess: (data) => ({ data, error: "" }),
      onFailure: (error) => ({ data: null, error: failure(error) }),
    }),
  );
