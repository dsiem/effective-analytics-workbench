import { Effect, Option, Scope, Stream } from "effect";
import { HttpClientResponse } from "effect/http";

export const scopedFetchBody = (
  response: HttpClientResponse.HttpClientResponse,
  scope: Scope.Closeable,
) => {
  const body = Option.getOrUndefined(HttpClientResponse.toWeb(response))?.body;
  if (!body) return response.stream;

  // Register before the stream acquires its reader, so the lock is released first.
  const release = Effect.addFinalizer((exit) =>
    Scope.close(scope, exit).pipe(
      Effect.andThen(
        Effect.sync(() => {
          // The request is already aborted. A Web body can leave cancel pending indefinitely.
          void body.cancel().catch(() => undefined);
        }),
      ),
    ),
  );
  return Stream.unwrap(
    release.pipe(
      Effect.as(
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: (error) => error,
          releaseLockOnEnd: true,
        }),
      ),
    ),
  );
};
