import { Effect, Schema } from "effect";
import { AuthenticationError, isSqlError, SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { DatabricksClient } from "@dsiem/sql-warehouse";
import { makeAdmission } from "./admission.js";
import { OperationTimeout, permissionDenied, unavailable } from "./errors.js";
import { Settings } from "./settings.js";
import { Workspace } from "./workspace.js";

export const makeWarehouse = Effect.gen(function* () {
  const settings = yield* Settings;
  const workspace = yield* Workspace;
  const configured = !!(
    settings.warehouseId &&
    settings.host &&
    settings.tripSnapshotTable
  );
  const [catalog = "unconfigured", schema = "snapshot", table = "trips"] =
    settings.tripSnapshotTable
      ? settings.tripSnapshotTable.split(".")
      : ["unconfigured", "snapshot", "trips"];
  const admit = makeAdmission({
    service: "warehouse",
    concurrency: settings.warehouseConcurrency,
    timeout: "90 seconds",
  });
  const error = unavailable(
    "warehouse",
    configured
      ? "The NYC taxi query failed. Check warehouse access and SELECT permission on the configured trip snapshot."
      : "Set DATABRICKS_WAREHOUSE_ID and TRIP_SNAPSHOT_TABLE to connect the NYC taxi dataset.",
  );
  const sql = yield* DatabricksClient.make({
    host: settings.host || "https://unconfigured.invalid",
    warehouseId: settings.warehouseId || "unconfigured",
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
        workspaceHost: settings.host,
        warehouseConfigured: !!settings.warehouseId,
      }),
    ),
    Effect.mapError((cause) =>
      unavailable(error.service, error.message, cause),
    ),
  );
  const snapshot = sql`${sql(catalog)}.${sql(schema)}.${sql(table)}`;
  const denied =
    "These trips are under lock. You need permission to read trip data.";
  const warehouseError = (cause: unknown, deniedMessage: string) => {
    if (cause instanceof OperationTimeout) return cause;
    if (
      isSqlError(cause) &&
      cause.reason._tag === "AuthorizationError" &&
      cause.reason.operation !== "download"
    )
      return permissionDenied(deniedMessage);
    return unavailable(error.service, error.message, cause);
  };
  const run = <A>(
    operation: Effect.Effect<A, unknown>,
    deniedMessage = denied,
  ) =>
    (configured ? operation.pipe(admit.effect) : Effect.fail(error)).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Warehouse operation failed", cause),
      ),
      Effect.mapError((cause) => warehouseError(cause, deniedMessage)),
    );
  const read = <A>(
    schema: Schema.Decoder<A>,
    statement: Effect.Effect<ReadonlyArray<unknown>, unknown>,
    deniedMessage = denied,
  ) =>
    run(
      SqlSchema.findAll({
        Request: Schema.Void,
        Result: schema,
        execute: () => statement,
      })(undefined),
      deniedMessage,
    );
  return { sql, snapshot, read, run, error };
});
