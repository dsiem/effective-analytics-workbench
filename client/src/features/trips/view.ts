import {
  recordGrid,
  recordViewportMount,
} from "@dsiem/workbench-ui/record-explorer";
import { Select } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { defineView } from "foldkit/submodel";
import type { TripSummary } from "@dsiem/analytics-shared/trips";
import { money, number } from "../../lib/format";
import { icon } from "../../ui/icons";
import {
  alert,
  badge,
  button,
  type Child,
  card,
  loading,
} from "../../ui/primitives";
import { type Model, previewRows, Sort, SortMenu, tripWindow } from "./model";
import type { H } from "./view-messages";
import { Message as M } from "./view-messages";

const sortLabels = {
  newest: "Latest pickup",
  fare: "Highest fare",
  distance: "Longest distance",
} satisfies Record<typeof Sort.Type, string>;
const decodeSort = Schema.decodeUnknownSync(Sort);

function tripCells(
  h: H,
  trip: TripSummary,
  counts: Model["commentCounts"],
  tabbable: boolean,
) {
  const count = Object.hasOwn(counts.data, trip.trip_id)
    ? counts.data[trip.trip_id]
    : undefined;
  const countLabel =
    count === undefined
      ? counts.phase._tag === "Loading"
        ? "Loading comment count"
        : counts.phase._tag === "Failed"
          ? "Comment count unavailable"
          : "View comments"
      : `${number(count)} ${count === 1 ? "comment" : "comments"}`;
  return [
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
            h.Tabindex(tabbable ? 0 : -1),
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
            h.Tabindex(tabbable ? 0 : -1),
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
  ];
}

function tripTable(h: H, model: Model, rows: readonly TripSummary[]) {
  return recordGrid(h, rows, {
    caption: "Matching trips",
    headers: [
      "Pickup time",
      "Route · ZIP codes",
      "Drop-off time",
      "Distance",
      "Duration",
      "Fare",
      "Comments",
    ],
    key: (trip) => `trip-${trip.trip_id}`,
    cells: (trip, tabbable) =>
      tripCells(h, trip, model.commentCounts, tabbable),
    window: tripWindow(rows.length, model.viewport),
    loading: model.preview._tag === "Loading",
    region: [
      h.Key(`records-${model.loadGeneration}`),
      h.Role("region"),
      h.AriaLabel("Scrollable trip records"),
      h.Tabindex(0),
      h.OnMount(
        recordViewportMount(model.loadGeneration, ({ generation, viewport }) =>
          M.TripsScrolled({ generation, viewport }),
        ),
      ),
    ],
  });
}

function sortControl(
  h: H,
  menu: Model["sortMenu"],
  sort: typeof Sort.Type,
  mobile: boolean,
) {
  if (mobile) {
    return h.submodel({
      slotId: "trip-sort-menu",
      model: menu,
      view: SortMenu.view,
      toParentMessage: (message) => M.GotSortMenuMessage({ message }),
      viewInputs: {
        anchor: { placement: "bottom-end", gap: 8, padding: 8 },
        ariaLabel: `Sort trips, currently ${sortLabels[sort]}`,
        items: Sort.literals,
        itemToSearchText: (option) => sortLabels[option],
        buttonContent: icon(h, "arrow-down-up"),
        buttonClassName: "btn btn-outline trip-sort-trigger",
        itemsClassName: "action-menu",
        backdropClassName: "action-menu-backdrop",
        itemToConfig: (option) => ({
          className: "action-menu-option",
          content: h.div(
            [h.Class("flex items-center gap-3 w-full")],
            [
              h.span([h.Class("flex-1")], [sortLabels[option]]),
              ...(option === sort
                ? [
                    icon(h, "check"),
                    h.span([h.Class("sr-only")], ["(selected)"]),
                  ]
                : []),
            ],
          ),
        }),
      },
    });
  }

  return Select.view(
    {
      id: "trip-sort",
      value: sort,
      onChange: (value) => M.SortTrips({ sort: decodeSort(value) }),
      toView: ({ select, label }) =>
        h.div(
          [h.Class("sort-control")],
          [
            h.label([...label, h.Class("muted text-sm")], ["Sort by"]),
            h.select(
              [
                ...select,
                h.AriaLabel("Sort trips"),
                h.Class("input sort-select"),
              ],
              Sort.literals.map((option) =>
                h.option([h.Value(option)], [sortLabels[option]]),
              ),
            ),
          ],
        ),
    },
    h,
  );
}

function trips(
  h: H,
  model: Model,
  sort: typeof Sort.Type,
  mobile: boolean,
): Child[] {
  const { preview } = model;
  const rows = previewRows(preview);
  const count = number(rows.length);
  const label =
    preview._tag === "Ready"
      ? preview.hasMore
        ? `${count} shown · more match`
        : rows.length === 1
          ? "1 trip"
          : `${count} trips`
      : rows.length
        ? `${count} loaded`
        : null;
  const counts = model.commentCounts.phase;
  const previewFailed = preview._tag === "Failed";
  const countError =
    counts._tag === "Failed"
      ? counts.error
      : counts._tag === "Loading"
        ? Option.getOrUndefined(counts.previousError)
        : null;

  return [
    card(
      h,
      [
        h.div(
          [h.Class("panel-header trip-records-header border-b")],
          [
            h.div(
              [h.Class("flex items-center gap-3")],
              [
                h.h2([], ["Matching trips"]),
                ...(label ? [badge(h, label)] : []),
              ],
            ),
            sortControl(h, model.sortMenu, sort, mobile),
          ],
        ),
        ...(rows.length
          ? [
              h.div(
                [h.Class("trip-grid-wrap")],
                [
                  h.p(
                    [h.Class("trip-scroll-help")],
                    ["Scroll horizontally to see all columns."],
                  ),
                  tripTable(h, model, rows),
                ],
              ),
            ]
          : []),
        ...(previewFailed || countError
          ? [
              h.div(
                [
                  h.Key("records-retry"),
                  h.Class("flex items-start justify-between gap-3 px-4 py-3"),
                ],
                [
                  h.div(
                    [h.Class("min-w-0 space-y-2")],
                    [
                      ...(previewFailed ? [alert(h, preview.error)] : []),
                      ...(countError ? [alert(h, countError)] : []),
                    ],
                  ),
                  button(h, {
                    label: "Try again",
                    onClick: previewFailed
                      ? M.Reload()
                      : M.RetryCommentCounts(),
                    busy: !previewFailed && counts._tag === "Loading",
                    className: "shrink-0",
                  }),
                ],
              ),
            ]
          : []),
        ...(preview._tag === "Loading"
          ? rows.length
            ? [
                h.p(
                  [h.Class("trip-refine"), h.Role("status")],
                  ["Loading trip records…"],
                ),
              ]
            : [loading(h)]
          : preview._tag === "Ready" && rows.length === 0
            ? [
                h.p(
                  [h.Class("p-14 muted text-center")],
                  [
                    "No pickups here. Try another ZIP code or a wider date range.",
                  ],
                ),
              ]
            : []),
      ],
      "trip-records",
    ),
  ];
}

export const tripsView = defineView<
  Model,
  typeof M.Type,
  { sort: typeof Sort.Type; mobile: boolean }
>((model, { sort, mobile }, h) =>
  h.div([h.Class("contents")], trips(h, model, sort, mobile)),
);
