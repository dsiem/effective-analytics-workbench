import { HttpApiClient } from "effect/http-api";
import { Lexer } from "marked";
import { AppApi } from "@dsiem/analytics-shared/api";
import type { GenieReply } from "@dsiem/analytics-shared/genie";
import { filterSummary } from "../../domain/filter-summary";
import { icon } from "../../ui/icons";
import { alert, button, type Child, table } from "../../ui/primitives";
import { markdown } from "./markdown-view";
import { stoppableOperation, type Turn } from "./model";
import { type H, Message as M } from "./view-messages";
import type { ViewModel as Model } from "./view-model";

const csvUrl = HttpApiClient.urlBuilder(AppApi).genie.downloadCsv;

const questions = {
  overview: [
    "Explain the main patterns in this view.",
    "Compare weekday and weekend trip activity.",
    "Which pickup hours have the highest average fare?",
  ],
  trips: [
    "Summarize the visible trips and point out unusual fares or distances.",
    "Find unusually high fares in the filtered dataset.",
    "Compare average fare by trip distance.",
  ],
  map: [
    "Explain the spatial pattern in this view.",
    "Compare the busiest areas shown here.",
    "Which areas have the highest average fare?",
  ],
  "saved-views": [
    "Summarize trip activity for the current filters.",
    "Compare weekday and weekend fares.",
  ],
  genie: [
    "Which pickup ZIP codes have the most trips?",
    "How does the average fare change by hour of day?",
    "Show total trips and fare revenue by month.",
  ],
};
function answer(h: H, clipboard: string, reply: GenieReply): Child[] {
  const { warning } = reply;
  const showMarkdown =
    warning === undefined ||
    reply.text.trim().length > 0 ||
    reply.queries.length > 0;
  return [
    ...(showMarkdown
      ? [
          h.div(
            [h.Class("markdown")],
            markdown(h, Lexer.lex(reply.text || "Query results")),
          ),
        ]
      : []),
    ...(warning === undefined
      ? []
      : [
          h.p(
            [h.Class("muted text-sm"), h.Role("status")],
            [
              warning.count === 1
                ? "Genie returned an attachment this app can’t display."
                : `Genie returned ${warning.count} attachments this app can’t display.`,
            ],
          ),
        ]),
    ...reply.queries.map((result) =>
      h.div(
        [h.Class("query-result")],
        [
          h.p(
            [h.Class("text-xs font-medium px-3 py-2 border-b bg-gray-100/50")],
            [result.description],
          ),
          h.div(
            [h.Class("max-h-72 overflow-auto")],
            [
              table(h, {
                caption: result.description || "Genie query result",
                headers: result.columns,
                rows: result.rows.map((row, index) => ({
                  key: String(index),
                  cells: row.map((cell) => cell ?? "—"),
                })),
              }),
            ],
          ),
          ...(result.truncated
            ? [
                h.p(
                  [h.Class("border-t px-3 py-2 text-xs muted")],
                  ["Showing a bounded preview of the query result."],
                ),
              ]
            : []),
          ...(reply.mode !== "agent" && result.attachmentId
            ? [
                h.form(
                  [
                    h.Class("border-t p-3"),
                    h.Method("post"),
                    h.Action(
                      csvUrl({
                        params: {
                          conversationId: reply.conversationId,
                          messageId: reply.messageId,
                          attachmentId: result.attachmentId,
                        },
                      }),
                    ),
                    h.Target("_blank"),
                    h.Rel("noopener"),
                  ],
                  [
                    ...(reply.grant
                      ? [
                          h.input([
                            h.Type("hidden"),
                            h.Name("grant"),
                            h.Value(reply.grant),
                          ]),
                        ]
                      : []),
                    button(h, {
                      label: "Download full CSV",
                      type: "submit",
                      size: "small",
                    }),
                    h.p(
                      [h.Class("muted mt-1 text-xs")],
                      ["Reruns the query with the latest data."],
                    ),
                  ],
                ),
              ]
            : []),
          h.details(
            [h.Class("border-t p-3")],
            [
              h.summary(
                [h.Class("text-xs font-medium cursor-pointer")],
                ["View generated SQL"],
              ),
              h.pre(
                [
                  h.Class(
                    "mt-3 whitespace-pre-wrap break-all text-xs leading-5 muted",
                  ),
                ],
                [result.sql],
              ),
              button(h, {
                label: clipboard === "Copied" ? "Copied" : "Copy SQL",
                onClick: M.CopySql({ sql: result.sql }),
                className: " mt-2",
                variant: "ghost",
              }),
              ...(clipboard && clipboard !== "Copied"
                ? [alert(h, clipboard)]
                : []),
            ],
          ),
        ],
      ),
    ),
  ];
}

function suggestions(h: H, page: Model["context"]["page"]) {
  return h.div(
    [h.Class("genie-welcome")],
    [
      h.h3([h.Class("text-lg font-semibold")], ["What caught your eye?"]),
      h.p(
        [h.Class("muted text-sm leading-6 mt-2 mb-5")],
        ["Explain what you’re seeing or ask Genie to run another analysis."],
      ),
      h.div(
        [h.Class("space-y-2 mb-5")],
        questions[page].map((question) =>
          button(h, {
            label: h.span(
              [h.Class("flex w-full items-center justify-between gap-3")],
              [h.span([], [question]), icon(h, "arrow-up-right")],
            ),
            onClick: M.SendQuestion({ question }),
            className: " suggestion",
          }),
        ),
      ),
    ],
  );
}

function response(
  h: H,
  turn: Turn,
  clipboard: string,
  working: boolean,
): Child[] {
  switch (turn.state) {
    case "complete":
      return answer(h, clipboard, turn.reply);
    case "failed":
    case "submission-unknown":
      return [alert(h, turn.error)];
    case "agent-mode-unavailable":
    case "submission-rejected":
      return [
        alert(h, turn.error),
        ...(turn.state === "agent-mode-unavailable"
          ? [
              button(h, {
                label: "Retry in Chat",
                onClick: M.RetryInChat({ id: turn.id }),
                disabled: working,
                className: " mt-3 mr-2",
              }),
            ]
          : []),
        button(h, {
          label: "Edit question",
          onClick: M.EditQuestion({ question: turn.question }),
          disabled: working,
          className: " mt-3",
        }),
      ];
    case "paused":
      return [
        alert(h, turn.error),
        button(h, {
          label:
            turn.stage === "retrieving"
              ? "Retry result download"
              : "Resume answer",
          onClick: M.ResumeTurn({ id: turn.id }),
          disabled: working,
          className: " mt-3",
        }),
      ];
    case "waiting": {
      const progress = {
        analyzing: "Analyzing your question…",
        "running-sql": "Running SQL…",
        "preparing-report": "Preparing the report…",
      };
      return [
        h.p(
          [h.Class("muted text-sm py-2"), h.Role("status")],
          [turn.phase ? progress[turn.phase] : "Processing query…"],
        ),
      ];
    }
    case "cancelled":
      return [
        h.p([h.Class("muted text-sm py-2")], ["Agent response stopped."]),
      ];
    case "stopping":
      return [
        h.p([h.Class("muted text-sm py-2")], ["Stopping Agent response…"]),
      ];
    case "retrieving":
      if (turn.operation.mode === "agent")
        return [
          h.p([h.Class("muted text-sm py-2")], ["Loading Agent report…"]),
        ];
      return [h.p([h.Class("muted text-sm py-2")], ["Processing query…"])];
    case "submitting":
      return [h.p([h.Class("muted text-sm py-2")], ["Processing query…"])];
  }
}

function conversationTurn(
  h: H,
  turn: Turn,
  clipboard: string,
  working: boolean,
) {
  return h.div(
    [h.Key(turn.id)],
    [
      h.div(
        [h.Class("question-bubble")],
        [
          h.p([], [turn.question]),
          ...(turn.context && turn.filters
            ? [
                h.details(
                  [h.Class("text-xs muted mt-2")],
                  [
                    h.summary(
                      [h.Class("cursor-pointer")],
                      [`${turn.context.title} · View context`],
                    ),
                    h.div([h.Class("mt-2")], [filterSummary(h, turn.filters)]),
                  ],
                ),
              ]
            : []),
        ],
      ),
      h.p(
        [h.Class("text-xs font-semibold mb-2 flex items-center gap-2")],
        [icon(h, "sparkles"), "Genie"],
      ),
      ...response(h, turn, clipboard, working),
      ...(stoppableOperation(turn)
        ? [
            button(h, {
              label: "Stop",
              onClick: M.StopTurn({ id: turn.id }),
              variant: "ghost",
              className: " mt-2",
            }),
          ]
        : []),
    ],
  );
}

export function history(
  h: H,
  model: Model,
  page: Model["context"]["page"],
  enabled: boolean,
  working: boolean,
) {
  return h.div(
    [h.Class("genie-messages")],
    [
      ...(model.persistenceError ? [alert(h, model.persistenceError)] : []),
      ...(!model.turns.length && enabled ? [suggestions(h, page)] : []),
      h.div(
        [h.AriaLive("polite"), h.Class("space-y-6")],
        model.turns.map((turn) =>
          conversationTurn(h, turn, model.clipboard, working),
        ),
      ),
    ],
  );
}
