import { Duration, Effect, Schedule, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import type { DatabricksClientConfig } from "../DatabricksClient.js";
import { withTransport } from "./http.js";
import type { ExternalLink } from "./protocol.js";
import {
  afterSubmission,
  failure,
  httpFailure,
  parseUrl,
  timeout,
} from "./protocol.js";

export const makeTransport = (options: DatabricksClientConfig) =>
  Effect.gen(function* () {
    const config = yield* Effect.try({
      try: () => {
        const host = parseUrl(options.host);
        if (
          host.pathname !== "/" ||
          host.search ||
          !options.warehouseId.trim()
        ) {
          throw new Error(
            "Expected a workspace origin and a nonempty warehouse ID",
          );
        }
        const poll = Duration.toMillis(
          Duration.fromInputUnsafe(options.pollInterval ?? "250 millis"),
        );
        const query = Duration.toMillis(
          Duration.fromInputUnsafe(options.queryTimeout ?? "2 minutes"),
        );
        const request = Duration.toMillis(
          Duration.fromInputUnsafe(options.requestTimeout ?? "30 seconds"),
        );
        if (![poll, query, request].every((n) => Number.isFinite(n) && n > 0)) {
          throw new Error(
            "Timeouts and polling interval must be positive finite durations",
          );
        }
        if (
          options.byteLimit !== undefined &&
          (!Number.isSafeInteger(options.byteLimit) || options.byteLimit <= 0)
        ) {
          throw new Error("byteLimit must be a positive safe integer");
        }
        return { host: host.origin, poll, query, request };
      },
      catch: () =>
        failure("Invalid Databricks client configuration", "configure"),
    });
    const withQueryTimeout = <A, E, R>(consumer: Effect.Effect<A, E, R>) =>
      consumer.pipe(
        Effect.timeoutOrElse({
          duration: config.query,
          orElse: () => Effect.fail(afterSubmission(timeout("query"))),
        }),
      );

    const requestJson = (
      path: string,
      operation: "submit" | "poll" | "metadata" | "cancel",
      body?: unknown,
    ) => {
      const read = operation === "poll" || operation === "metadata";
      const request = Effect.gen(function* () {
        const token = yield* options.accessToken;
        return yield* withTransport(
          Effect.gen(function* () {
            const client = HttpClient.filterStatusOk(
              HttpClient.withScope(yield* HttpClient.HttpClient),
            );
            const request = HttpClientRequest.make(read ? "GET" : "POST")(
              `${config.host}${path}`,
            ).pipe(HttpClientRequest.bearerToken(token));
            const response = yield* client.execute(
              body === undefined
                ? request
                : yield* HttpClientRequest.bodyJson(request, body),
            );
            return yield* response.json;
          }),
          options.fetch,
          options.workspaceHttpClient,
        ).pipe(
          Effect.mapError((cause) => {
            if (cause instanceof SqlError) return cause;
            // Map the reason only. Raw HTTP errors contain credentials and bodies.
            const reason = HttpClientError.isHttpClientError(cause)
              ? cause.reason
              : undefined;
            if (reason?._tag === "DecodeError")
              return failure("Invalid Databricks API response", operation);
            const status =
              reason?._tag === "StatusCodeError"
                ? reason.response.status
                : undefined;
            const error =
              status === undefined
                ? new SqlError({
                    reason: new ConnectionError({
                      cause: undefined,
                      message: "Databricks workspace request failed",
                      operation,
                    }),
                  })
                : httpFailure(status, operation);
            return operation === "submit" && status !== 429
              ? afterSubmission(error)
              : error;
          }),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: config.request,
          orElse: () => Effect.fail(afterSubmission(timeout(operation))),
        }),
      );
      // A lost submission response is ambiguous: never automatically replay SQL.
      return read
        ? request.pipe(
            Effect.retry({
              while: (error) => error.reason._tag === "ConnectionError",
              times: 2,
              schedule: Schedule.exponential("100 millis"),
            }),
            Effect.mapError(afterSubmission),
          )
        : request;
    };

    const download = (link: ExternalLink, maxBytes?: number) =>
      Effect.gen(function* () {
        const safeUrl = yield* Effect.try({
          try: () =>
            parseUrl(link.external_link, options.allowDatabricksStorageProxy),
          catch: () => failure("Invalid Arrow download URL", "download"),
        });
        return yield* withTransport(
          Effect.gen(function* () {
            // Fresh request: signed storage URLs never inherit workspace headers.
            const client = HttpClient.withScope(yield* HttpClient.HttpClient);
            const response = yield* client.get(safeUrl, {
              headers: link.http_headers,
            });
            if (response.status < 200 || response.status >= 300)
              return { status: response.status, bytes: new Uint8Array() };
            if (maxBytes === undefined)
              return {
                status: response.status,
                bytes: new Uint8Array(yield* response.arrayBuffer),
              };
            const parts: Uint8Array[] = [];
            let size = 0;
            yield* Stream.runForEach(response.stream, (part) =>
              Effect.gen(function* () {
                size += part.byteLength;
                if (size > maxBytes)
                  return yield* Effect.fail(
                    failure("Arrow result exceeds the byte limit", "download"),
                  );
                parts.push(part);
              }),
            );
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const part of parts) {
              bytes.set(part, offset);
              offset += part.byteLength;
            }
            return {
              status: response.status,
              bytes,
            };
          }).pipe(
            // Signed URLs and link-specific headers can both contain credentials.
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          ),
          options.fetch,
        ).pipe(
          Effect.mapError((error) =>
            error instanceof SqlError
              ? error
              : failure("Arrow download failed", "download"),
          ),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: config.request,
          orElse: () => Effect.fail(afterSubmission(timeout("download"))),
        }),
      );

    return { config, requestJson, download, withQueryTimeout };
  });
