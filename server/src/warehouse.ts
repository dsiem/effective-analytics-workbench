import { Context, Effect, Layer, Option, Schema } from "effect";
import { AuthenticationError, isSqlError, SqlError } from "effect/sql/SqlError";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlSchema from "effect/sql/SqlSchema";
import { DatabricksClient } from "@dsiem/sql-warehouse";
import { makeAdmission } from "./admission.js";
import {
  permissionDenied,
  type ServiceUnavailable,
  unavailable,
} from "./errors.js";
import { Settings } from "./settings.js";
import { Workspace } from "./workspace.js";

const makeWarehouse = Effect.gen(function* () {
  const settings = yield* Settings;
  const { host, warehouseId } = settings;
  if (!host || !warehouseId) return Option.none();

  const workspace = yield* Workspace;
  const admit = makeAdmission({
    service: "warehouse",
    concurrency: settings.warehouseConcurrency,
    timeout: "90 seconds",
  });
  const sql = yield* DatabricksClient.make({
    host,
    warehouseId,
    accessToken: workspace.accessToken.pipe(
      Effect.mapError(
        (cause) =>
          new SqlError({
            reason: new AuthenticationError({
              cause,
              message: "Authentication unavailable",
              operation: "authenticate",
            }),
          }),
      ),
    ),
    queryTimeout: "90 seconds",
    allowDatabricksStorageProxy: !!settings.appName,
  }).pipe(
    Effect.tapError(() =>
      Effect.logError("Invalid SQL client configuration", {
        workspaceHost: host,
      }),
    ),
    Effect.mapError((cause) =>
      unavailable("warehouse", "Invalid SQL warehouse configuration.", cause),
    ),
  );

  const queries = <E extends ServiceUnavailable>(errors: {
    readonly deniedMessage: string;
    readonly unavailable: (cause: unknown) => E;
  }) => {
    const run = <A>(operation: Effect.Effect<A, unknown>) =>
      operation.pipe(
        Effect.mapError((cause) =>
          isSqlError(cause) &&
          cause.reason._tag === "AuthorizationError" &&
          cause.reason.operation !== "download"
            ? permissionDenied(errors.deniedMessage)
            : errors.unavailable(cause),
        ),
        admit.effect,
      );
    const read = <A>(
      schema: Schema.Decoder<A>,
      statement: Effect.Effect<ReadonlyArray<unknown>, unknown>,
    ) =>
      run(
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: schema,
          execute: () => statement,
        })(undefined),
      );
    return { run, read };
  };

  return Option.some({ sql, queries });
});

export class Warehouse extends Context.Service<
  Warehouse,
  Effect.Success<typeof makeWarehouse>
>()("app/Warehouse") {
  static readonly layer = Layer.effect(this, makeWarehouse).pipe(
    Layer.provide(Reactivity.layer),
  );
}
