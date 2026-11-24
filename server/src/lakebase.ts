import { PgClient } from "@effect/sql-pg";
import {
  Context,
  Effect,
  Exit,
  Layer,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import type * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import {
  PermissionDenied,
  type ServiceError,
  type ServiceUnavailable,
  isWorkspacePermissionDenied,
  permissionDenied,
  unavailable,
} from "./errors.js";
import { pgPassword, restoreCredentialFailure } from "./pg-credentials.js";
import { Settings } from "./settings.js";
import { Workspace } from "./workspace.js";

export type LakebaseSql = SqlClient.SqlClient & Pick<PgClient.PgClient, "json">;

export const lakebaseFailure =
  (
    deniedMessage: string,
    unavailableMessage = "Lakebase is unavailable. Check its connection settings. For database initialization, see DEPLOYMENT.md.",
  ) =>
  (cause: unknown) => {
    if (cause instanceof PermissionDenied) return cause;
    if (
      (isSqlError(cause) && cause.reason._tag === "AuthorizationError") ||
      isWorkspacePermissionDenied(cause)
    )
      return permissionDenied(deniedMessage);
    return unavailable("lakebase", unavailableMessage, cause);
  };

const Credential = Schema.Struct({ token: Schema.NonEmptyString });
const Endpoint = Schema.Struct({
  status: Schema.Struct({
    hosts: Schema.Struct({ host: Schema.NonEmptyString }),
  }),
});
export const makeLakebaseClient = Effect.gen(function* () {
  const settings = yield* Settings;
  const workspace = yield* Workspace;
  const host =
    settings.pgHost ||
    (yield* workspace
      .request(`/api/2.0/postgres/${settings.lakebaseEndpoint}`)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Endpoint)),
        Effect.map((endpoint) => endpoint.status.hosts.host),
      ));
  const password = Redacted.value(settings.pgPassword)
    ? Effect.succeed(settings.pgPassword)
    : pgPassword(
        workspace
          .request("/api/2.0/postgres/credentials", "POST", {
            endpoint: settings.lakebaseEndpoint,
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Credential)),
            Effect.map((credential) => Redacted.make(credential.token)),
            Effect.mapError(
              lakebaseFailure(
                "You need permission to access saved views and comments.",
                "Lakebase credentials could not be refreshed. Check workspace authentication and endpoint permissions.",
              ),
            ),
          ),
      );
  return yield* PgClient.make({
    host,
    port: settings.pgPort,
    database: settings.pgDatabase,
    username: settings.pgUser || settings.clientId,
    password,
    ssl: true,
    minConnections: 0,
    maxConnections: 4,
    connectTimeout: "15 seconds",
    acquireTimeout: "20 seconds",
    idleTimeout: "30 seconds",
    connectionTTL: "45 minutes",
    startupParameters: { statement_timeout: "15000" },
    applicationName: "databricks-effect-app",
  });
});

export class Lakebase extends Context.Service<
  Lakebase,
  {
    /** Run a feature operation on the shared client. */
    readonly use: <A, E extends ServiceError, R>(
      run: (sql: LakebaseSql) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | ServiceUnavailable<"lakebase"> | PermissionDenied,
      R
    >;
  }
>()("app/Lakebase") {
  static readonly layer = Layer.effect(
    Lakebase,
    Effect.gen(function* () {
      const settings = yield* Settings;
      if (!settings.pgHost && !settings.lakebaseEndpoint) {
        const failure = unavailable(
          "lakebase",
          "Configure the Lakebase connection. See DEPLOYMENT.md for setup commands.",
        );
        return { use: () => Effect.fail(failure) };
      }
      const context = yield* Effect.context<
        Settings | Workspace | Reactivity.Reactivity | Scope.Scope
      >();
      // One pool per service lifetime. Failed or interrupted discovery can retry;
      // initialization stays lazy so an outage cannot block application startup.
      const client = yield* makeLakebaseClient.pipe(
        Effect.mapError(
          lakebaseFailure(
            "You need permission to access saved views and comments.",
          ),
        ),
        Effect.provide(context),
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? Infinity : 0)),
      );
      return {
        use: <A, E extends ServiceError, R>(
          run: (sql: LakebaseSql) => Effect.Effect<A, E, R>,
        ) => client.pipe(Effect.flatMap(run), restoreCredentialFailure),
      };
    }).pipe(Effect.provide(Reactivity.layer)),
  );
}
