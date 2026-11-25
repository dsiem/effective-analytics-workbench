import { Dialog, Select, Textarea } from "@foldkit/ui";
import { Option } from "effect";
import { defineView } from "foldkit/submodel";
import { filterSummary } from "../../domain/filter-summary";
import { dialog } from "../../ui/dialog";
import { icon } from "../../ui/icons";
import { alert, button, type Child } from "../../ui/primitives";
import { PanelReturnFocus } from "./focus";
import { history } from "./history-view";
import { busy } from "./model";
import type { H } from "./view-messages";
import { Message as M } from "./view-messages";
import type { ViewModel as Model } from "./view-model";

function header(h: H, model: Model, floating: boolean, working: boolean) {
  const title = h.h2(
    [
      h.Id(
        floating && model.mobile
          ? Dialog.titleId(model.helperDialog)
          : "genie-title",
      ),
    ],
    ["Genie"],
  );
  return h.div(
    [h.Class("genie-header")],
    [
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          h.span([h.Class("icon-tile")], [icon(h, "sparkles")]),
          floating
            ? title
            : h.div(
                [],
                [
                  title,
                  h.p([h.Class("muted text-xs")], ["Your data, in context"]),
                ],
              ),
        ],
      ),
      h.div(
        [h.Class("flex items-center gap-1")],
        [
          button(h, {
            label: icon(h, "plus"),
            onClick: M.NewConversation(),
            disabled: working || !model.turns.length,
            attributes: [h.AriaLabel("New conversation")],
            variant: "ghost",
          }),
          ...(floating
            ? [
                button(h, {
                  label: icon(
                    h,
                    model.genieExpanded ? "minimize-2" : "maximize-2",
                  ),
                  onClick: M.ExpandGenie(),
                  attributes: [
                    h.AriaLabel(
                      model.genieExpanded ? "Minimize Genie" : "Expand Genie",
                    ),
                  ],
                  className: " hidden md:inline-flex",
                  variant: "ghost",
                }),
                button(h, {
                  label: icon(h, "x"),
                  onClick: M.CloseGenie(),
                  attributes: [h.AriaLabel("Close Genie")],
                  variant: "ghost",
                }),
              ]
            : []),
        ],
      ),
    ],
  );
}

function scope(h: H, model: Model, context: Model["context"]) {
  return h.section(
    [
      h.AriaLabel("Explore view for your next question"),
      h.Class("genie-context"),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-2 mb-2")],
        [
          h.div(
            [],
            [
              h.p(
                [h.Class("muted text-[10px] uppercase tracking-widest mb-1")],
                ["Looking at"],
              ),
              h.h3([h.Class("text-sm font-medium")], [context.title]),
            ],
          ),
          ...(Option.isSome(model.genieSelection)
            ? [
                button(h, {
                  label: icon(h, "x"),
                  onClick: M.ClearSelection(),
                  attributes: [h.AriaLabel("Use whole page")],
                  variant: "ghost",
                }),
              ]
            : []),
        ],
      ),
      ...(model.filters
        ? [filterSummary(h, model.filters)]
        : [alert(h, "Correct the page filters before asking Genie.")]),
      h.p(
        [h.Class("muted text-[11px] leading-4 mt-2")],
        [
          `${context.data ? "Displayed data and applied filters included." : "Applied filters included."} Earlier answers keep their original view.`,
        ],
      ),
    ],
  );
}

function composer(h: H, model: Model, enabled: boolean, working: boolean) {
  const draft = model.genieDraft;
  return h.div(
    [h.Class("genie-composer")],
    [
      h.form(
        [h.OnSubmit(M.SendQuestion({ question: draft }))],
        [
          Textarea.view(
            {
              id: "genie-composer",
              placeholder: "Ask about this view…",
              value: draft,
              isDisabled: !enabled,
              onInput: (value) => M.GenieDraft({ value }),
              toView: (attributes) =>
                h.textarea([
                  ...attributes.textarea,
                  h.AriaLabel("Ask a question about taxi data"),
                  h.Maxlength(3500),
                  h.OnKeyDownPreventDefault((key, modifiers) =>
                    key === "Enter" && !modifiers.shiftKey
                      ? Option.some(M.SendQuestion({ question: draft }))
                      : Option.none(),
                  ),
                ]),
            },
            h,
          ),
          h.div(
            [h.Class("flex items-center justify-between gap-2 mt-2")],
            [
              Select.view(
                {
                  id: "genie-mode",
                  value: model.genieMode,
                  onChange: (value) =>
                    M.SetGenieMode({
                      mode: value === "agent" ? "agent" : "chat",
                    }),
                  toView: ({ select }) =>
                    h.select(
                      [
                        ...select,
                        h.AriaLabel("Genie mode"),
                        h.Class("input text-xs"),
                      ],
                      [
                        h.option([h.Value("chat")], ["Chat"]),
                        h.option([h.Value("agent")], ["Agent mode"]),
                      ],
                    ),
                },
                h,
              ),
              working
                ? h.span(
                    [h.Class("muted text-[11px]")],
                    ["Working on your question…"],
                  )
                : null,
              button(h, {
                type: "submit",
                variant: "primary",
                size: "icon",
                disabled: !enabled || working || !draft.trim(),
                label: icon(h, "arrow-up"),
                attributes: [h.AriaLabel("Send question")],
              }),
            ],
          ),
        ],
      ),
      h.p(
        [h.Class("muted text-[10px] text-center mt-2")],
        ["Genie can make mistakes. Check the SQL and results."],
      ),
    ],
  );
}

function genie(h: H, model: Model, floating = false) {
  const context = Option.getOrElse(model.genieSelection, () => model.context);
  const enabled = model.filters !== null;
  const working = busy(model);
  const content: Child[] = [
    header(h, model, floating, working),
    scope(h, model, context),
    history(h, model, context.page, enabled, working),
    composer(h, model, enabled, working),
  ];
  if (!floating) return h.div([h.Class("genie-full")], content);
  const classes = `genie-panel ${model.genieExpanded ? "expanded" : ""}`;
  if (model.mobile)
    return dialog(h, {
      model: model.helperDialog,
      onMessage: (message) => M.GotGenieDialogMessage({ message }),
      className: classes,
      children: content,
    });
  // The desktop helper stays non-modal so the user can explore alongside it.
  return h.dialog(
    [
      h.Key("genie-helper"),
      h.OnMount(PanelReturnFocus()),
      h.Open(true),
      h.AriaLabelledBy("genie-title"),
      h.Class(classes),
      h.OnKeyDownPreventDefault((key) =>
        key === "Escape" ? Option.some(M.CloseGenie()) : Option.none(),
      ),
    ],
    content,
  );
}

export const genieView = defineView<Model, typeof M.Type>((model, h) =>
  genie(h, model),
);
export const genieHelperView = defineView<Model, typeof M.Type>((model, h) =>
  genie(h, model, true),
);
