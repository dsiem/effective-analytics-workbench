import { AccessDenied } from "../../lib/request-state";
import { Tooltip } from "@foldkit/ui";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { defineView } from "foldkit/submodel";
import type { ChildAttribute } from "foldkit/html";
import type {
  AnalysisInput,
  AnalysisRunState,
  AnalysisRunSummary,
  RouteReliabilityReport,
  RouteReliabilityRow,
} from "@dsiem/analytics-shared/analysis-runs";
import { number } from "../../lib/format";
import { icon } from "../../ui/icons";
import {
  alert,
  button,
  card,
  type H as Builder,
  panelHeader,
  table,
} from "../../ui/primitives";
import { analysisForm } from "./form-view";
import { Message as M, type Message } from "./messages";
import { historyHref, type Model, runHref } from "./model";

type H = Builder<Message>;
type ViewInputs = { readonly query: string };

function reuseInputs(
  h: H,
  model: Model,
  input: AnalysisInput,
  succeeded: boolean,
) {
  const disabled = model.submission._tag === "Submitting";
  const trigger = (attributes: ReadonlyArray<ChildAttribute> = []) =>
    button(h, {
      label: "Reuse these inputs",
      onClick: M.ReuseAnalysisInputs({ input }),
      disabled,
      size: "small",
      attributes,
    });
  if (!succeeded) return trigger();
  return h.submodel({
    slotId: "reuse-tooltip",
    view: Tooltip.view,
    model: model.reuseTooltip,
    toParentMessage: (message) => M.ReuseTooltip({ message }),
    viewInputs: {
      anchor: { placement: "top", gap: 8 },
      isDisabled: disabled,
      toView: ({ trigger: attributes, panel, isVisible }) =>
        h.div(
          [],
          [
            trigger(attributes),
            ...(isVisible
              ? [
                  h.div(
                    [...panel, h.Class("tooltip-panel")],
                    ["Same question, different week?"],
                  ),
                ]
              : []),
          ],
        ),
    },
  });
}

const states = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
  unknown: "Status unavailable",
} satisfies Record<AnalysisRunState, string>;

const bands = {
  overnight: "00:00–06:00",
  morning: "06:00–12:00",
  afternoon: "12:00–18:00",
  evening: "18:00–00:00",
} satisfies Record<typeof RouteReliabilityRow.Type.timeBand, string>;

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const change = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

const status = (h: H, state: AnalysisRunState) =>
  h.span(
    [h.Class("analysis-status"), h.DataAttribute("state", state)],
    [states[state]],
  );

const startedBy = (name: string | null) =>
  name ? `Started by ${name}` : "Requester unavailable";

const duration = (start: number, end: number) => {
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const pageHeading = (h: H, text: string) =>
  h.h1([h.Id("analysis-heading"), h.Tabindex(-1)], [text]);

const newRun = (h: H, model: Model) =>
  button(h, {
    label: h.span(
      [h.Class("inline-flex items-center gap-2")],
      [icon(h, "plus"), "New run"],
    ),
    variant: "primary",
    onClick: M.OpenAnalysisForm(),
    disabled: model.submission._tag === "Submitting",
  });

function historyRow(h: H, run: AnalysisRunSummary, query: string) {
  return h.li(
    [h.Key(String(run.id))],
    [
      h.a(
        [h.Href(runHref(run.id, query)), h.Class("analysis-history-link")],
        [
          h.span([h.Class("analysis-run-id")], [`Run #${run.id}`]),
          status(h, run.state),
          h.span(
            [h.Class("analysis-start-time")],
            [
              run.startedAt === null
                ? "Start time unavailable"
                : dateTime.format(run.startedAt),
            ],
          ),
          h.span(
            [h.Class("analysis-requester")],
            [
              ...(run.requestedBy
                ? [h.span([h.Class("@min-[40rem]:sr-only")], ["Started by "])]
                : []),
              run.requestedBy ?? "Requester unavailable",
            ],
          ),
          icon(h, "chevron-right"),
        ],
      ),
    ],
  );
}

function recentRuns(h: H, model: Model, query: string) {
  const data = Option.getOrUndefined(AsyncData.getData(model.recent));
  const error = Option.getOrUndefined(AsyncData.getError(model.recent));
  const loading = AsyncData.isPending(model.recent);
  return card(h, [
    panelHeader(h, {
      title: "Recent runs",
      actions: [
        button(h, {
          label: "Refresh",
          size: "small",
          variant: "ghost",
          onClick: M.RefreshAnalysisHistory(),
          busy: loading,
        }),
      ],
    }),
    ...(error
      ? [h.div([h.Class("analysis-panel-body")], [alert(h, error)])]
      : []),
    ...(data?.length
      ? [
          h.div(
            [h.Class("analysis-history-head"), h.AriaHidden(true)],
            ["Run", "Status", "Started", "Started by"].map((label) =>
              h.span([], [label]),
            ),
          ),
          h.ul(
            [h.Class("analysis-history")],
            data.map((run) => historyRow(h, run, query)),
          ),
        ]
      : error
        ? []
        : [
            h.p(
              [h.Class("empty-state"), h.Role("status")],
              [
                loading
                  ? "Loading recent runs…"
                  : "No runs yet. Start a new run to compare two weeks.",
              ],
            ),
          ]),
  ]);
}

function reportTable(h: H, report: typeof RouteReliabilityReport.Type) {
  if (!report.rows.length) {
    return h.p(
      [h.Class("analysis-panel-body muted text-sm")],
      ["No routes met the minimum trip count in both weeks."],
    );
  }
  const metric = (minutes: number, trips: number) =>
    h.div(
      [],
      [
        h.span(
          [h.Class("font-semibold tabular-nums")],
          [`${minutes.toFixed(1)} min`],
        ),
        h.span([h.Class("analysis-detail")], [`${number(trips)} trips`]),
      ],
    );
  return h.div(
    [h.Class("analysis-report-table")],
    [
      table(h, {
        caption:
          "Route reliability by pickup ZIP, drop-off ZIP, and pickup time",
        headers: [
          "Pickup → Drop-off",
          "Baseline p90",
          "Comparison p90",
          "Change",
        ],
        rows: report.rows.map((row) => {
          const delta = row.comparisonP90Minutes - row.baselineP90Minutes;
          return {
            key: `${row.pickupZip}-${row.dropoffZip}-${row.timeBand}`,
            cells: [
              h.div(
                [],
                [
                  h.span(
                    [h.Class("font-semibold")],
                    [`${row.pickupZip} → ${row.dropoffZip}`],
                  ),
                  h.span([h.Class("analysis-detail")], [bands[row.timeBand]]),
                ],
              ),
              metric(row.baselineP90Minutes, row.baselineCount),
              metric(row.comparisonP90Minutes, row.comparisonCount),
              h.span(
                [
                  h.Class(
                    `font-semibold tabular-nums ${delta > 0 ? "error-text" : ""}`,
                  ),
                ],
                [`${change.format(delta)} min`],
              ),
            ],
          };
        }),
      }),
    ],
  );
}

const weekStart = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
});

function selectedRun(
  h: H,
  model: Model,
  selected: NonNullable<Model["selected"]>,
  query: string,
) {
  const { detail, report } = selected;
  const run = detail.data;
  const input = report.data?.input ?? run?.input;
  const terminal =
    run?.state === "succeeded" ||
    run?.state === "failed" ||
    run?.state === "canceled";
  const inputValue = (label: string, value: string) =>
    h.div([], [h.dt([], [label]), h.dd([], [value])]);

  return h.div(
    [h.Class("analysis-report")],
    [
      h.div(
        [h.Class("analysis-report-toolbar")],
        [
          h.a(
            [h.Href(historyHref(query)), h.Class("analysis-back")],
            [icon(h, "chevron-left"), "All runs"],
          ),
          newRun(h, model),
        ],
      ),
      h.header(
        [h.Class("analysis-report-heading")],
        [
          h.p([h.Class("analysis-report-type")], ["Route reliability"]),
          h.div(
            [h.Class("analysis-run-title")],
            [
              pageHeading(h, `Run #${selected.id}`),
              h.span(
                [h.Role("status")],
                [
                  run
                    ? status(h, run.state)
                    : detail.loading
                      ? "Checking status…"
                      : "Status unavailable",
                ],
              ),
            ],
          ),
          ...(run
            ? [
                h.div(
                  [h.Class("analysis-run-meta")],
                  [
                    h.span([], [startedBy(run.requestedBy)]),
                    ...(run.startedAt !== null
                      ? [
                          h.span([], [dateTime.format(run.startedAt)]),
                          h.span(
                            [],
                            [
                              `Elapsed ${duration(run.startedAt, run.endedAt ?? selected.observedAt)}`,
                            ],
                          ),
                        ]
                      : []),
                  ],
                ),
              ]
            : []),
        ],
      ),
      ...(input
        ? [
            card(
              h,
              [
                h.dl(
                  [h.Class("analysis-input-values")],
                  [
                    inputValue(
                      "Baseline week starts",
                      weekStart.format(new Date(input.baselineWeek)),
                    ),
                    inputValue(
                      "Comparison week starts",
                      weekStart.format(new Date(input.comparisonWeek)),
                    ),
                    inputValue(
                      "Minimum trips per week",
                      number(input.minimumTrips),
                    ),
                  ],
                ),
                ...(terminal
                  ? [reuseInputs(h, model, input, run.state === "succeeded")]
                  : []),
              ],
              "analysis-input-summary",
            ),
          ]
        : []),
      ...(detail.error ? [alert(h, detail.error)] : []),
      ...((!run && detail.error) || run?.state === "unknown"
        ? [
            button(h, {
              label: "Check status",
              size: "small",
              busy: detail.loading,
              onClick: M.RetryAnalysisStatus(),
            }),
          ]
        : []),
      ...(run?.reason
        ? [
            run.reasonCode === "permission_denied"
              ? alert(h, AccessDenied.make({ message: run.reason }))
              : h.p([h.Class("muted text-sm")], [run.reason]),
          ]
        : []),
      ...(run?.state === "running" || run?.state === "queued"
        ? [
            h.p(
              [h.Class("muted text-sm")],
              ["The report will appear here when the run finishes."],
            ),
          ]
        : []),
      ...(report.loading
        ? [
            h.p(
              [h.Role("status"), h.Class("muted text-sm")],
              ["Loading report…"],
            ),
          ]
        : []),
      ...(report.error
        ? [
            h.div(
              [h.Class("space-y-3")],
              [
                alert(h, report.error),
                button(h, {
                  label: "Retry report",
                  size: "small",
                  onClick: M.RetryAnalysisReport(),
                }),
              ],
            ),
          ]
        : []),
      ...(report.data
        ? [
            card(h, [
              panelHeader(h, {
                title: "Route changes",
                description:
                  "Up to 50 routes ranked by the size of the change in p90 trip time. A p90 trip time is the time within which 90% of trips finish.",
              }),
              reportTable(h, report.data),
            ]),
          ]
        : []),
    ],
  );
}

export const analysisRunsView = defineView<Model, Message, ViewInputs>(
  (model, { query }, h) =>
    h.div(
      [h.Class("analysis-page")],
      [
        ...(model.selected
          ? [selectedRun(h, model, model.selected, query)]
          : [
              h.header(
                [h.Class("page-title")],
                [
                  h.div(
                    [],
                    [
                      pageHeading(h, "Analysis runs"),
                      h.p(
                        [h.Class("muted mt-2")],
                        ["Compare route reliability across two weeks."],
                      ),
                    ],
                  ),
                  newRun(h, model),
                ],
              ),
              ...(model.invalidLink
                ? [
                    h.div(
                      [h.Class("mb-4")],
                      [
                        alert(
                          h,
                          "This run link is invalid. Choose a recent run or start a new one.",
                        ),
                      ],
                    ),
                  ]
                : []),
              recentRuns(h, model, query),
            ]),
        analysisForm(h, model),
      ],
    ),
);
