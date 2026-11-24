import { type Duration, Effect, Exit, Scope, Semaphore } from "effect";
import { OperationTimeout } from "./errors.js";

// Construct once per service, outside request and cache lookups. The deadline
// surrounds acquisition so expired or interrupted waiters cannot start work.
const operation = {
  warehouse: "Warehouse query",
  genie: "Genie submission",
  genie_csv: "Genie CSV export",
};

export const makeAdmission = <const S extends keyof typeof operation>(options: {
  readonly concurrency: number;
  readonly timeout: Duration.Input;
  readonly service: S;
}) => {
  const semaphore = Semaphore.makeUnsafe(options.concurrency);
  const timeout = () =>
    new OperationTimeout({
      service: options.service,
      message: `${operation[options.service]} timed out while waiting or running. Try again.`,
    });
  const withinDeadline = Effect.timeoutOrElse({
    duration: options.timeout,
    orElse: () => Effect.fail(timeout()),
  });
  return {
    effect: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      semaphore.withPermit(effect).pipe(withinDeadline),
    scoped: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Scope.Scope);
        return yield* semaphore.takeScoped(1).pipe(
          Effect.andThen(effect),
          Scope.provide(scope),
          withinDeadline,
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
          ),
        );
      }),
  };
};
