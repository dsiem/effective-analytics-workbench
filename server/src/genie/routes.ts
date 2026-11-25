import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api";
import { AppApi, genieCsvHeaders } from "@dsiem/analytics-shared/api";
import { withApiErrors } from "../api-boundary.js";
import { InvalidRequest, type ServiceError } from "../errors.js";
import { Genie, type GenieViewer } from "./service.js";

export const GenieRoutes = HttpApiBuilder.group(AppApi, "genie", (handlers) =>
  Effect.gen(function* () {
    const { forViewer } = yield* Genie;
    const withViewer = <A, E extends ServiceError, R>(
      request: HttpServerRequest.HttpServerRequest,
      use: (genie: GenieViewer) => Effect.Effect<A, E, R>,
    ) =>
      withApiErrors(
        forViewer(request.headers["x-forwarded-user"]).pipe(
          Effect.flatMap(use),
        ),
      );

    return handlers.handleAll({
      submit: ({ request, payload, headers }) =>
        withViewer(request, (genie) =>
          genie.submit(payload, headers["x-genie-access"]),
        ),
      poll: ({ request, params, query, headers }) =>
        withViewer(request, (genie) =>
          genie.poll({ ...params, ...query }, headers["x-genie-access"]),
        ),
      cancel: ({ request, params, headers }) =>
        withViewer(request, (genie) =>
          genie.cancel(params, headers["x-genie-access"]),
        ),
      result: ({ request, params, query, headers }) =>
        withViewer(request, (genie) =>
          genie.result({ ...params, ...query }, headers["x-genie-access"]),
        ),
      downloadCsv: ({ request, params, payload }) =>
        withViewer(request, (genie) =>
          Effect.gen(function* () {
            const site = request.headers["sec-fetch-site"];
            if (site !== undefined && site !== "same-origin")
              return yield* new InvalidRequest({
                message: "Open the query in Genie to export its results.",
              });
            const body = yield* genie.downloadCsv(params, payload?.grant);
            return HttpApiSchema.withHeaders({
              body,
              headers: genieCsvHeaders,
            });
          }),
        ),
    });
  }),
);
