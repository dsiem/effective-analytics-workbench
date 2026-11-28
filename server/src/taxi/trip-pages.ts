import { Effect, Schema } from "effect";
import {
  makeRecordPreview,
  type PreviewChunk,
} from "@dsiem/analytics/record-preview";
import {
  defaultTripLimit,
  TripPage,
  type TripSearch,
  type TripSort,
  type TripSummary,
} from "@dsiem/analytics-shared/trips";
import { InvalidRequest, unavailable } from "../errors.js";

const encoder = new TextEncoder();
const encodePageJson = Schema.encodeEffect(Schema.fromJsonString(TripPage));
const encodePage = (page: TripPage) =>
  encodePageJson(page).pipe(
    Effect.orDie,
    Effect.map((json) => encoder.encode(json)),
  );

type Search = TripSearch & {
  readonly limit: number;
  readonly sort: typeof TripSort.Type;
};
export const makeTripPages = <E>(
  start: (search: Search) => Effect.Effect<PreviewChunk<TripSummary, E>, E>,
) =>
  makeRecordPreview({
    start,
    encodePage,
    cacheable: (search) => search.limit <= defaultTripLimit,
    invalidCursor: () =>
      new InvalidRequest({
        message:
          "This trip page cursor is invalid or expired. Reload the preview.",
      }),
    inconsistentPage: () =>
      unavailable(
        "warehouse",
        "The warehouse returned an inconsistent trip page. Reload the preview.",
      ),
  }).pipe(
    Effect.map(({ open, page }) => ({
      trips: ({
        sort = "newest",
        limit = defaultTripLimit,
        ...filters
      }: TripSearch) =>
        open({ sort, limit, ...filters }).pipe(
          Effect.withSpan("analytics.trips"),
        ),
      tripPage: (cursor: string) =>
        page(cursor).pipe(Effect.withSpan("analytics.tripPage")),
    })),
  );
