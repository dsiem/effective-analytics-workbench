import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { AppApi } from "../../shared/api.js";
import { AnalysisRuns } from "./analysis-runs.js";
import { Analytics } from "./analytics.js";
import { ApiBoundaryLive, withApiErrors } from "./api-boundary.js";
import { CurrentViewer } from "./current-user.js";
import { GenieRoutes } from "./genie-routes.js";
import { SavedViews } from "./saved-views.js";
import { TripComments } from "./trip-comments.js";
import { WebRoutes } from "./web-routes.js";

const ViewerRoutes = HttpApiBuilder.group(AppApi, "viewer", (handlers) =>
  Effect.gen(function* () {
    const currentUser = yield* CurrentViewer;
    return handlers.handle("current", ({ request }) =>
      currentUser(request.headers),
    );
  }),
);

const compressPage = HttpMiddleware.compression({ algorithms: ["gzip"] });
const serveTripPage = Effect.map((body: Uint8Array) =>
  HttpServerResponse.uint8Array(body, { contentType: "application/json" }),
);

const AnalyticsRoutes = HttpApiBuilder.group(AppApi, "analytics", (handlers) =>
  Effect.gen(function* () {
    const analytics = yield* Analytics;
    return handlers.handleAll({
      metadata: () => withApiErrors(analytics.metadata),
      overview: ({ query }) => withApiErrors(analytics.overview(query)),
      trips: ({ query }) =>
        withApiErrors(analytics.trips(query)).pipe(serveTripPage, compressPage),
      tripPage: ({ params }) =>
        withApiErrors(analytics.tripPage(params.cursor)).pipe(
          serveTripPage,
          compressPage,
        ),
      tripDetails: ({ query }) =>
        withApiErrors(analytics.tripDetails(query.tripId)),
      tripMap: ({ query }) => withApiErrors(analytics.tripMap(query)),
    });
  }),
);

const AnalysisRunRoutes = HttpApiBuilder.group(
  AppApi,
  "analysisRuns",
  (handlers) =>
    Effect.gen(function* () {
      const runs = yield* AnalysisRuns;
      const currentUser = yield* CurrentViewer;
      return handlers.handleAll({
        submit: ({ payload, request }) =>
          withApiErrors(
            currentUser(request.headers).pipe(
              Effect.flatMap((user) =>
                runs.submit(payload, user?.name ?? null),
              ),
            ),
          ),
        list: () => withApiErrors(runs.list),
        get: ({ params }) => withApiErrors(runs.get(params.id)),
        result: ({ params }) => withApiErrors(runs.result(params.id)),
      });
    }),
);

const SavedViewRoutes = HttpApiBuilder.group(AppApi, "savedViews", (handlers) =>
  Effect.gen(function* () {
    const views = yield* SavedViews;
    return handlers.handleAll({
      list: ({ query }) => withApiErrors(views.list(query)),
      save: ({ payload }) => withApiErrors(views.save(payload)),
      pin: ({ params, payload }) =>
        withApiErrors(views.pin(params.id, payload)),
      remove: ({ params, query }) =>
        withApiErrors(views.remove(params.id, query.version)).pipe(
          Effect.as({ deleted: true as const }),
        ),
    });
  }),
);

const TripCommentRoutes = HttpApiBuilder.group(
  AppApi,
  "tripComments",
  (handlers) =>
    Effect.gen(function* () {
      const comments = yield* TripComments;
      const currentUser = yield* CurrentViewer;
      return handlers.handleAll({
        list: ({ query }) => withApiErrors(comments.list(query)),
        counts: ({ query }) => withApiErrors(comments.counts(query)),
        add: ({ payload, request }) =>
          withApiErrors(
            currentUser(request.headers).pipe(
              Effect.flatMap((author) => comments.add(payload, author)),
            ),
          ),
      });
    }),
);

const ApiRoutes = Layer.mergeAll(
  ViewerRoutes,
  AnalyticsRoutes,
  AnalysisRunRoutes,
  GenieRoutes,
  SavedViewRoutes,
  TripCommentRoutes,
).pipe(Layer.provide([ApiBoundaryLive, CurrentViewer.layer]));

export const Routes = Layer.merge(
  HttpApiBuilder.layer(AppApi).pipe(Layer.provide(ApiRoutes)),
  WebRoutes,
);
