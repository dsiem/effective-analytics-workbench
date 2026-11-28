import { commentList } from "@dsiem/workbench-ui/record-explorer";
import { Dialog, Textarea } from "@foldkit/ui";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";
import type { Coordinates } from "@dsiem/analytics-shared/trips";
import { money } from "../../lib/format";
import { dialog } from "../../ui/dialog";
import { icon } from "../../ui/icons";
import {
  alert,
  badge,
  button,
  type Child,
  error,
  loading,
} from "../../ui/primitives";
import { Message as M } from "./messages";
import type { Model } from "./model";

type H = HtmlBuilder<typeof M.Type>;

const close = (h: H, label = "Close") =>
  button(h, {
    label: icon(h, "x"),
    onClick: M.CloseTrip(),
    attributes: [h.AriaLabel(label)],
    className: " dialog-close",
    variant: "ghost",
  });
function inspector(h: H, model: Model) {
  const inspector = Option.getOrUndefined(model.inspector);
  if (!inspector) return null;
  const { details: tripDetails, comments: thread } = inspector;
  const loadedTrip = Option.getOrUndefined(AsyncData.getData(tripDetails));
  const loadError = Option.getOrUndefined(AsyncData.getError(tripDetails));
  const trip = loadedTrip ?? inspector.trip;
  const details = loadedTrip?.details;
  const location = (point: typeof Coordinates.Type | null) =>
    point
      ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`
      : "Unavailable";
  const amount = (value: number | null) =>
    value === null ? "Unavailable" : money(value, 2);
  const payment = [
    "Unknown",
    "Credit card",
    "Cash",
    "No charge",
    "Dispute",
    "Unknown",
    "Voided trip",
  ];
  const draft = model.commentDrafts[trip.trip_id];
  const threadData = Option.getOrUndefined(thread.data);
  const loadingComments = Option.isSome(thread.read);
  const rows = threadData?.rows ?? [];
  const info = (label: string, value: string) =>
    h.div([], [h.dt([], [label]), h.dd([], [value])]);
  const disclosure = (label: string, children: Child[]) =>
    h.details(
      [h.Class("trip-detail-group")],
      [
        h.summary([], [h.span([], [label]), icon(h, "chevron-down")]),
        ...children,
      ],
    );
  const comments: Child[] =
    loadingComments && !threadData
      ? [loading(h, "Loading comments…")]
      : thread.error && !threadData
        ? [error(h, thread.error, M.LoadComments({ more: false }))]
        : [
            ...(!rows.length
              ? [
                  h.div(
                    [h.Class("empty-comments")],
                    [
                      h.p(
                        [h.Class("text-sm font-medium")],
                        ["Know the story behind this ride?"],
                      ),
                      h.p(
                        [h.Class("muted text-xs leading-5 mt-1")],
                        ["Add the first comment."],
                      ),
                    ],
                  ),
                ]
              : []),
            commentList(h, rows),
            ...(thread.error ? [alert(h, thread.error)] : []),
            ...(threadData?.nextCursor || thread.error
              ? [
                  button(h, {
                    label: loadingComments
                      ? "Loading…"
                      : thread.error
                        ? "Retry loading comments"
                        : "Load older comments",
                    onClick: M.LoadComments({
                      more: !!threadData?.nextCursor,
                    }),
                    disabled: loadingComments,
                    className: " w-full mt-4",
                  }),
                ]
              : []),
          ];
  return dialog(h, {
    model: model.inspectorDialog,
    onMessage: (message) => M.GotInspectorDialogMessage({ message }),
    className: "dialog-panel sheet trip-inspector",
    children: [
      close(h),
      h.div(
        [h.Class("dialog-header")],
        [
          h.h2(
            [h.Id(Dialog.titleId(model.inspectorDialog)), h.Tabindex(-1)],
            ["Record details"],
          ),
        ],
      ),
      h.div(
        [h.Class("sheet-body")],
        [
          h.section(
            [h.AriaLabel("Selected trip"), h.Class("trip-summary")],
            [
              h.p(
                [h.Class("text-lg font-semibold mb-3")],
                [`${trip.pickup_zip} → ${trip.dropoff_zip}`],
              ),
              h.dl(
                [h.Class("trip-summary-grid")],
                [
                  info("Pickup", trip.pickup_at),
                  info("Drop-off", trip.dropoff_at),
                  info("Fare", money(trip.fare, 2)),
                  ...(details
                    ? [
                        info(
                          "Total · excl. cash tips",
                          amount(details.total_amount),
                        ),
                      ]
                    : []),
                  info("Distance", `${trip.distance.toFixed(2)} mi`),
                  info("Duration", `${trip.duration.toFixed(1)} min`),
                  ...(details
                    ? [
                        info(
                          "Passengers · driver reported",
                          details.passenger_count === null
                            ? "Unavailable"
                            : String(details.passenger_count),
                        ),
                        info(
                          "Payment",
                          payment[details.payment_type ?? 0] ?? "Unknown",
                        ),
                      ]
                    : []),
                ],
              ),
              ...(AsyncData.isPending(tripDetails)
                ? [
                    h.p(
                      [h.Role("status"), h.Class("muted text-sm")],
                      ["Loading trip details…"],
                    ),
                  ]
                : []),
              ...(loadError
                ? [
                    alert(h, loadError),
                    button(h, {
                      label: "Retry loading trip details",
                      onClick: M.RetryTripDetails(),
                    }),
                  ]
                : []),
              ...(details
                ? [
                    disclosure("Fare breakdown", [
                      h.dl(
                        [h.Class("trip-fare-breakdown")],
                        [
                          info("Base fare", money(trip.fare, 2)),
                          info("Recorded tip", amount(details.tip_amount)),
                          info("Tolls", amount(details.tolls_amount)),
                          info("Extras", amount(details.extra)),
                          info("MTA tax", amount(details.mta_tax)),
                          info(
                            "Improvement surcharge",
                            amount(details.improvement_surcharge),
                          ),
                        ],
                      ),
                      h.p(
                        [h.Class("muted text-xs pb-3")],
                        ["Recorded tip and total exclude cash tips."],
                      ),
                    ]),
                    disclosure("Source details", [
                      h.dl(
                        [h.Class("trip-source-details")],
                        [
                          info("Trip ID", trip.trip_id),
                          info(
                            "Pickup GPS · latitude, longitude",
                            location(details.pickup_location),
                          ),
                          info(
                            "Drop-off GPS · latitude, longitude",
                            location(details.dropoff_location),
                          ),
                          info(
                            "Rate code · provider",
                            `${details.rate_code_id ?? "Unknown"} · ${details.vendor_id ?? "Unknown"}`,
                          ),
                          info("Source file", details.source_file),
                        ],
                      ),
                    ]),
                  ]
                : []),
            ],
          ),
          h.div(
            [h.Class("flex justify-between items-center mb-3")],
            [
              h.h2(
                [h.Id("trip-comments-heading"), h.Tabindex(-1)],
                ["Comments"],
              ),
              badge(h, "Shared with your team"),
            ],
          ),
          ...comments,
        ],
      ),
      h.form(
        [
          h.Class(
            `comment-composer${draft?.body.length || model.postError ? " is-expanded" : ""}`,
          ),
          h.OnSubmit(M.PostComment()),
        ],
        [
          h.label(
            [h.For("trip-comment"), h.Class("sr-only")],
            ["Add a comment"],
          ),
          Textarea.view(
            {
              id: "trip-comment",
              value: draft?.body ?? "",
              onInput: (body) => M.CommentChanged({ body }),
              placeholder: "Add a comment…",
              toView: (attributes) =>
                h.textarea([
                  ...attributes.textarea,
                  h.Class("input"),
                  h.Rows(1),
                  h.Maxlength(4000),
                ]),
            },
            h,
          ),
          ...(model.postError
            ? [
                alert(
                  h,
                  model.postError,
                  typeof model.postError === "string"
                    ? " Your draft is kept here. Retry when ready."
                    : " Your draft is kept here.",
                ),
              ]
            : []),
          ...(model.posted === trip.trip_id
            ? [
                h.p(
                  [h.Role("status"), h.Class("muted text-xs")],
                  ["Comment posted"],
                ),
              ]
            : []),
          button(h, {
            type: "submit",
            variant: "primary",
            disabled: Option.isSome(model.postingTripId) || !draft?.body.trim(),
            label:
              Option.getOrUndefined(model.postingTripId) === trip.trip_id
                ? "Posting…"
                : "Post comment",
          }),
        ],
      ),
    ],
  });
}

export const inspectorView = defineView<Model, typeof M.Type>((model, h) =>
  inspector(h, model),
);
