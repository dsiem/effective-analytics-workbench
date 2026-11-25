import { Effect, Schema, type Scope } from "effect";
import { ApiError } from "@dsiem/analytics-shared/api";
import { AccessDenied, Notice } from "./request-state";

const successTag = "Success";
const Failure = Schema.TaggedStruct("Failure", { error: Notice });

export const Completion = <A extends Schema.Top>(data: A) =>
  Schema.Union([Schema.TaggedStruct(successTag, { data }), Failure]);

export const succeed = <A>(
  data: A,
): { readonly _tag: typeof successTag; readonly data: A } => ({
  _tag: successTag,
  data,
});
export const fail = (error: Notice) => Failure.make({ error });

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
      onSuccess: succeed<A>,
      onFailure: (error) => fail(failure(error)),
    }),
  );
