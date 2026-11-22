import { Select } from "@foldkit/ui";
import { Schema } from "effect";
import { defineView } from "foldkit/submodel";
import { money, number } from "../../lib/format";
import { icon } from "../../ui/icons";
import {
  alert,
  badge,
  button,
  type Child,
  card,
  error,
  loading,
  table,
  title,
} from "../../ui/primitives";
import type { Model } from "./model";
import { Sort, tripPageNumber } from "./model";
import type { H } from "./view-messages";
import { Message as M } from "./view-messages";

function trips(h: H, model: Model, sort: typeof Sort.Type): Child[] {
  const { data, loading: isLoading } = model.trips;
  const requestedPage = tripPageNumber(model);
  const heading = title(
    h,
    "Trip records",
    "Explore individual trips. Open a record to inspect its details and discuss it with your team.",
  );
  if (isLoading && !data) return [heading, loading(h)];
  if (model.trips.error)
    return [
      heading,
      error(h, model.trips.error, M.Reload()),
      ...(requestedPage > 1
        ? [button(h, { label: "Previous page", onClick: M.PreviousPage() })]
        : []),
    ];
  if (!data) return [heading];
  const page = model.displayedPage;
  const loadingPrevious = isLoading && requestedPage < page;
  const loadingNext = isLoading && requestedPage > page;
  const spinner = h.span([h.Class("spinner"), h.AriaHidden(true)], []);
  const precedingRows = (page - 1) * data.pageSize;
  return [
    heading,
    card(
      h,
      [
        h.div(
          [h.Class("panel-header border-b")],
          [
            h.div(
              [h.Class("flex items-center gap-3")],
              [
                h.h2([], ["Matching trips"]),
                badge(h, `${number(data.total)} trips`),
              ],
            ),
            Select.view(
              {
                id: "trip-sort",
                value: sort,
                onChange: (value) =>
                  M.SortTrips({ sort: Schema.decodeUnknownSync(Sort)(value) }),
                toView: ({ select, label }) =>
                  h.div(
                    [h.Class("sort-control")],
                    [
                      h.label(
                        [...label, h.Class("muted text-sm")],
                        ["Sort by"],
                      ),
                      h.select(
                        [
                          ...select,
                          h.AriaLabel("Sort trips"),
                          h.Class("input sort-select"),
                        ],
                        (["newest", "fare", "distance"] as const).map((sort) =>
                          h.option(
                            [h.Value(sort)],
                            [
                              {
                                newest: "Latest pickup",
                                fare: "Highest fare",
                                distance: "Longest distance",
                              }[sort],
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
              },
              h,
            ),
          ],
        ),
        ...(model.commentCounts.error
          ? [
              h.div(
                [h.Class("px-4 py-2")],
                [alert(h, model.commentCounts.error)],
              ),
            ]
          : []),
        table(h, {
          caption: "Matching trips",
          headers: [
            "Pickup time",
            "Route · ZIP codes",
            "Drop-off time",
            "Distance",
            "Duration",
            "Fare",
            h.span([h.Class("sr-only")], ["Trip actions"]),
          ],
          rows: data.rows.map((trip) => {
            const count = model.commentCounts.data?.[trip.trip_id];
            const countLabel =
              count === undefined
                ? model.commentCounts.loading
                  ? "Loading comment count"
                  : "Comment count unavailable"
                : `${number(count)} ${count === 1 ? "comment" : "comments"}`;
            return {
              key: trip.trip_id,
              cells: [
                trip.pickup_at,
                `${trip.pickup_zip} → ${trip.dropoff_zip}`,
                trip.dropoff_at,
                `${trip.distance.toFixed(2)} mi`,
                `${trip.duration.toFixed(1)} min`,
                money(trip.fare, 2),
                h.div(
                  [h.Class("trip-row-actions")],
                  [
                    button(h, {
                      label: h.span(
                        [h.Class("trip-comment-count")],
                        [
                          icon(h, "message-square"),
                          count === undefined ? "–" : number(count),
                        ],
                      ),
                      onClick: M.InspectComments({ trip }),
                      className: `trip-comments-button${count ? " has-comments" : ""}`,
                      attributes: [
                        h.Title(`${countLabel} · Open conversation`),
                        h.AriaLabel(
                          `${countLabel} for trip ${trip.pickup_at} from ${trip.pickup_zip} to ${trip.dropoff_zip}`,
                        ),
                      ],
                      variant: "ghost",
                    }),
                    button(h, {
                      label: icon(h, "chevron-right"),
                      onClick: M.InspectTrip({ trip }),
                      attributes: [
                        h.Title("View record details"),
                        h.AriaLabel(
                          `Details and comments for trip ${trip.pickup_at} from ${trip.pickup_zip} to ${trip.dropoff_zip}`,
                        ),
                      ],
                      className: "trip-details-button",
                      variant: "ghost",
                    }),
                  ],
                ),
              ],
            };
          }),
        }),
        ...(!data.rows.length
          ? [
              h.p(
                [h.Class("p-14 muted text-center")],
                [
                  page === 1
                    ? "No pickups here. Try another ZIP code or a wider date range."
                    : "No trips remain on this page.",
                ],
              ),
            ]
          : []),
        h.div(
          [h.Class("pagination")],
          [
            h.span(
              [h.Class("muted text-xs")],
              [
                data.rows.length
                  ? `${number(precedingRows + 1)}–${number(precedingRows + data.rows.length)} of ${number(data.total)}`
                  : "0 records",
              ],
            ),
            h.span(
              [h.Class("sr-only"), h.Role("status")],
              [isLoading ? `Loading page ${requestedPage}…` : ""],
            ),
            h.div(
              [h.Class("flex items-center gap-3")],
              [
                button(h, {
                  label: loadingPrevious ? spinner : icon(h, "chevron-left"),
                  onClick: M.PreviousPage(),
                  disabled: page === 1 || (isLoading && !loadingPrevious),
                  busy: loadingPrevious,
                  attributes: [h.AriaLabel("Previous page")],
                }),
                h.span([], [`Page ${page}`]),
                button(h, {
                  label: loadingNext ? spinner : icon(h, "chevron-right"),
                  onClick: M.NextPage(),
                  disabled:
                    data.nextCursor === null || (isLoading && !loadingNext),
                  busy: loadingNext,
                  attributes: [h.AriaLabel("Next page")],
                }),
              ],
            ),
          ],
        ),
      ],
      "trip-records",
    ),
    h.p(
      [h.Class("muted text-sm mt-4")],
      [
        "Source timestamps are shown as recorded. Fares are in USD and distances are in miles.",
      ],
    ),
  ];
}

export const tripsView = defineView<
  Model,
  typeof M.Type,
  { sort: typeof Sort.Type }
>((model, { sort }, h) => h.div([h.Class("contents")], trips(h, model, sort)));
