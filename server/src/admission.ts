import { type Duration, Effect, Semaphore } from "effect";
import { OperationTimeout } from "./errors.js";

// Construct once per service, outside request and cache lookups. The deadline
// surrounds acquisition so expired or interrupted waiters cannot start work.
const operation = {
  warehouse: "Warehouse query",
  genie: "Genie submission",
  genie_csv: "Genie CSV preparation",
};

export const makeAdmission = (options: {
  readonly concurrency: number;
  readonly timeout: Duration.Input;
  readonly service: keyof typeof operation;
}) => {
  const semaphore = Semaphore.makeUnsafe(options.concurrency);
  const timeout = () =>
    new OperationTimeout({
      service: options.service,
      message: `${operation[options.service]} timed out while waiting or running. Try again.`,
    });
  const admit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    semaphore.withPermit(effect).pipe(
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () => Effect.fail(timeout()),
      }),
    );
  return { effect: admit };
};
