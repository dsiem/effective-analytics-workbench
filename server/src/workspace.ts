import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Context,
  Effect,
  Layer,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { scopedFetchBody } from "@dsiem/genie-client";
import { Credentials } from "@dsiem/sql-warehouse";
import {
  OperationTimeout,
  type ServiceUnavailable,
  type WorkspaceRequestError,
  UpstreamError,
  unavailable,
} from "./errors.js";
import { Settings } from "./settings.js";

const run = promisify(execFile);
const CliToken = Schema.Struct({ access_token: Schema.NonEmptyString });
const featureDisabled = Schema.is(
  Schema.Struct({ error_code: Schema.Literal("FEATURE_DISABLED") }),
);

type ReadEventStream<A, E, R> = (
  body: Stream.Stream<Uint8Array, WorkspaceRequestError>,
) => Effect.Effect<A, E, R>;

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly accessToken: Effect.Effect<
      Redacted.Redacted<string>,
      ServiceUnavailable<"auth">
    >;
    readonly request: (
      path: string,
      method?: "GET" | "POST",
      body?: unknown,
    ) => Effect.Effect<unknown, WorkspaceRequestError>;
    readonly requestEvents: <A, E, R>(
      path: string,
      body: unknown,
      read: ReadEventStream<A, E, R>,
    ) => Effect.Effect<A, WorkspaceRequestError | E, R>;
  }
>()("app/Workspace") {
  static readonly layer = Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const client = yield* HttpClient.HttpClient;
      const authError = (cause: unknown) =>
        unavailable(
          "auth",
          "Databricks authentication failed. Run databricks auth login locally, or check the app service principal.",
          cause,
        );
      const cli = yield* Effect.tryPromise({
        try: async (signal) =>
          JSON.parse(
            (
              await run(
                "databricks",
                [
                  "auth",
                  "token",
                  ...(settings.profile ? ["--profile", settings.profile] : []),
                ],
                { signal, timeout: 15000, maxBuffer: 1024 * 1024 },
              )
            ).stdout,
          ) as unknown,
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CliToken)),
        Effect.map((value) => Redacted.make(value.access_token)),
        Effect.mapError(authError),
        Effect.cachedWithTTL("30 seconds"),
      );
      const accessToken = Redacted.value(settings.token)
        ? Effect.succeed(settings.token)
        : settings.clientId && Redacted.value(settings.clientSecret)
          ? Credentials.clientCredentials({
              host: settings.host,
              clientId: settings.clientId,
              clientSecret: settings.clientSecret,
              scope: "all-apis",
            }).pipe(Effect.mapError(authError))
          : cli;
      const requestFailure = (cause: unknown) =>
        unavailable(
          "workspace",
          "The Databricks request could not be completed.",
          cause,
        );
      const withResponse = <A, E, R>(
        path: string,
        method: "GET" | "POST",
        body: unknown,
        read: (
          response: HttpClientResponse.HttpClientResponse,
          scope: Scope.Closeable,
        ) => Effect.Effect<A, E, R>,
        accept?: "text/event-stream",
      ) =>
        Effect.gen(function* () {
          if (!settings.host)
            return yield* Effect.fail(
              unavailable(
                "workspace",
                "Set DATABRICKS_HOST to your workspace URL.",
              ),
            );
          const token = yield* accessToken;
          return yield* Effect.gen(function* () {
            const scope = yield* Scope.fork(yield* Scope.Scope);
            const jsonRequest = HttpClientRequest.make(method)(
              `${settings.host.replace(/\/$/, "")}${path}`,
            ).pipe(
              HttpClientRequest.bearerToken(token),
              HttpClientRequest.setHeader("Content-Type", "application/json"),
            );
            const request = accept
              ? HttpClientRequest.setHeader(jsonRequest, "Accept", accept)
              : jsonRequest;
            const response = yield* (
              body === undefined
                ? Effect.succeed(request)
                : HttpClientRequest.bodyJson(request, body)
            ).pipe(
              Effect.flatMap((request) =>
                HttpClient.withScope(client)
                  .execute(request)
                  .pipe(Scope.provide(scope)),
              ),
              Effect.mapError(requestFailure),
            );
            if (response.status < 200 || response.status >= 300) {
              const disabled =
                response.status === 404 &&
                accept === "text/event-stream" &&
                (yield* response.json.pipe(
                  Effect.map(featureDisabled),
                  Effect.orElseSucceed(() => false),
                ));
              return yield* Effect.fail(
                new UpstreamError({
                  service: "workspace",
                  upstreamStatus: response.status,
                  ...(disabled
                    ? { upstreamCode: "FEATURE_DISABLED" as const }
                    : {}),
                  message: `Databricks returned HTTP ${response.status}. Check resource permissions and configuration.`,
                }),
              );
            }
            return yield* read(response, scope);
          }).pipe(
            Effect.scoped,
            Effect.provideService(FetchHttpClient.RequestInit, {
              redirect: "error",
              credentials: "omit",
            }),
          );
        }).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.fail(
                new OperationTimeout({
                  service: "workspace",
                  message: "Databricks request timed out.",
                }),
              ),
          }),
        );
      const request = (
        path: string,
        method: "GET" | "POST" = "GET",
        body?: unknown,
      ) =>
        withResponse(path, method, body, (response) =>
          Effect.mapError(response.json, requestFailure),
        );
      const requestEvents = <A, E, R>(
        path: string,
        body: unknown,
        read: ReadEventStream<A, E, R>,
      ) =>
        withResponse(
          path,
          "POST",
          body,
          (response, scope) =>
            read(
              Stream.mapError(scopedFetchBody(response, scope), requestFailure),
            ),
          "text/event-stream",
        );
      return { accessToken, request, requestEvents };
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
