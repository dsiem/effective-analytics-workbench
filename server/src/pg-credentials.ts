import { Cause, Data, Effect, type Redacted } from "effect";
import type { PermissionDenied, ServiceUnavailable } from "./errors.js";

type CredentialError = ServiceUnavailable<"lakebase"> | PermissionDenied;

class CredentialFailure extends Data.TaggedError("CredentialFailure")<{
  readonly cause: CredentialError;
}> {}

// sql-pg requires an infallible password Effect. Only this adapter bridges that
// constraint; ordinary defects and interruption must keep their original meaning.
export const pgPassword = (
  password: Effect.Effect<Redacted.Redacted<string>, CredentialError>,
) =>
  password.pipe(
    Effect.mapError((cause) => new CredentialFailure({ cause })),
    Effect.orDie,
  );

export const restoreCredentialFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(
        Cause.fromReasons(
          cause.reasons.map((reason): Cause.Reason<E | CredentialError> =>
            Cause.isDieReason(reason) &&
            reason.defect instanceof CredentialFailure
              ? Cause.makeFailReason(reason.defect.cause).annotate(
                  Cause.reasonAnnotations(reason),
                )
              : reason,
          ),
        ),
      ),
    ),
  );
