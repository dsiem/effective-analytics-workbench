import { Effect, Option, pipe, Schema, SchemaGetter } from "effect";
import * as Route from "foldkit/route";
import { defineTaggedUnion } from "foldkit/schema";
import {
  AnalysisRunId,
  AnalysisRunIdFromString,
} from "@dsiem/analytics-shared/analysis-runs";
import { Filters } from "@dsiem/analytics-shared/filters";
import { pagePaths } from "@dsiem/analytics-shared/page-paths";
import { TripSort } from "@dsiem/analytics-shared/trips";
import { filtersFromQuery, href } from "../domain/filters";

const AnalysisRunLink = defineTaggedUnion({
  NoRun: {},
  InvalidRun: {},
  SelectedRun: { id: AnalysisRunId },
});
export type AnalysisRunLink = typeof AnalysisRunLink.Type;

export const AppRoute = Route.defineRouteUnion({
  Overview: {},
  Trips: { sort: TripSort },
  TripMap: {},
  AnalysisRuns: { run: AnalysisRunLink },
  Genie: {},
  NotFound: { path: Schema.String },
});
export type AppRoute = typeof AppRoute.Type;

export const Location = Schema.Struct({
  route: AppRoute,
  query: Schema.String,
  filters: Schema.NullOr(Filters),
});
export type Location = typeof Location.Type;

const defaultSort = "newest";
const decodeTripSort = Schema.decodeUnknownOption(TripSort);
const TripSortQuery = Schema.Struct({
  sort: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(Schema.Struct({ sort: TripSort }), {
    decode: SchemaGetter.transform(
      ({ sort }): { sort: typeof TripSort.Type } => ({
        sort: Option.getOrElse(decodeTripSort(sort), () => defaultSort),
      }),
    ),
    encode: SchemaGetter.transform(({ sort }) =>
      sort === defaultSort ? {} : { sort },
    ),
  }),
);

const decodeAnalysisRunId = Schema.decodeUnknownOption(AnalysisRunIdFromString);
const AnalysisRunQuery = Schema.Struct({
  run: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(Schema.Struct({ run: Schema.toType(AnalysisRunLink) }), {
    decode: SchemaGetter.transform(({ run }) => {
      if (run === undefined) return { run: AnalysisRunLink.NoRun() };
      const id = decodeAnalysisRunId(run);
      return {
        run: Option.isSome(id)
          ? AnalysisRunLink.SelectedRun({ id: id.value })
          : AnalysisRunLink.InvalidRun(),
      };
    }),
    encode: SchemaGetter.transform(({ run }) =>
      AnalysisRunLink.match<{ run?: string }>(run, {
        NoRun: () => ({}),
        InvalidRun: () => ({ run: "" }),
        SelectedRun: ({ id }) => ({ run: String(id) }),
      }),
    ),
  }),
);

const overviewRouter = pipe(Route.root, Route.mapTo(AppRoute.Overview));
const tripsRouter = pipe(
  Route.literal(pagePaths.Trips.slice(1)),
  Route.query(TripSortQuery),
  Route.mapTo(AppRoute.Trips),
);
const tripMapRouter = pipe(
  Route.literal(pagePaths.TripMap.slice(1)),
  Route.mapTo(AppRoute.TripMap),
);
const analysisRunsRouter = pipe(
  Route.literal(pagePaths.AnalysisRuns.slice(1)),
  Route.query(AnalysisRunQuery),
  Route.mapTo(AppRoute.AnalysisRuns),
);
const genieRouter = pipe(
  Route.literal(pagePaths.Genie.slice(1)),
  Route.mapTo(AppRoute.Genie),
);
const router = Route.oneOf(
  overviewRouter,
  tripsRouter,
  tripMapRouter,
  analysisRunsRouter,
  genieRouter,
);

export const pageUrls = {
  Overview: overviewRouter(),
  Trips: tripsRouter({ sort: defaultSort }),
  TripMap: tripMapRouter(),
  AnalysisRuns: analysisRunsRouter({ run: AnalysisRunLink.NoRun() }),
  Genie: genieRouter(),
} satisfies Record<keyof typeof pagePaths, string>;

export const routePath = (route: AppRoute) =>
  route._tag === "NotFound" ? route.path : pageUrls[route._tag];

export const showsExplore = (route: AppRoute) =>
  route._tag !== "Genie" && route._tag !== "AnalysisRuns";

const encodeTripSort = Schema.encodeSync(TripSortQuery);
export const withTripSort = (query: string, sort: typeof TripSort.Type) => {
  const params = new URLSearchParams(query);
  params.delete("sort");
  const encoded = encodeTripSort({ sort });
  if (encoded.sort !== undefined) params.set("sort", encoded.sort);
  return params.toString();
};

export const withoutRun = (query: string) => {
  const params = new URLSearchParams(query);
  if (!params.has("run")) return query;
  params.delete("run");
  return params.toString();
};
export const historyHref = (query: string) =>
  href(pageUrls.AnalysisRuns, withoutRun(query));

const encodeAnalysisRunQuery = Schema.encodeSync(AnalysisRunQuery);
export const runHref = (id: AnalysisRunId, query: string) => {
  const params = new URLSearchParams(query);
  const encoded = encodeAnalysisRunQuery({
    run: AnalysisRunLink.SelectedRun({ id }),
  });
  if (encoded.run !== undefined) params.set("run", encoded.run);
  return href(pageUrls.AnalysisRuns, params.toString());
};

function parseRoute(path: string, params: URLSearchParams): AppRoute {
  if (!path.startsWith("/")) return AppRoute.NotFound({ path });
  // Keep exact path matching and the first occurrence of route query keys.
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const routeParams = new URLSearchParams();
  for (const [key, value] of params) {
    if (!routeParams.has(key)) routeParams.append(key, value);
  }
  return router.parse(segments, routeParams.toString()).pipe(
    Effect.map(([route]) => route),
    Effect.catch(() => Effect.succeed(AppRoute.NotFound({ path }))),
    Effect.runSync,
  );
}

export function parseLocation(path: string, query: string): Location {
  const params = new URLSearchParams(query);
  return {
    route: parseRoute(path, params),
    query,
    filters: filtersFromQuery(params),
  };
}
