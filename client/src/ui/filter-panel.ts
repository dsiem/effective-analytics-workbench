import { button, type Child, type H } from "./primitives";

/** Controls and summaries belong to the caller; the panel knows no filter schema. */
export function filterPanel<Message>(
  h: H<Message>,
  options: {
    readonly label: string;
    readonly viewPicker: Child;
    readonly fields: ReadonlyArray<Child>;
    readonly saveAction: Child;
    readonly onApply: Message;
    readonly onReset?: Message;
    readonly hasChanges: boolean;
    readonly appliedSummary?: Child;
    readonly error?: string;
    readonly notice?: string;
  },
) {
  return h.form(
    [
      h.AriaLabel(options.label),
      h.Class("filter-bar"),
      h.OnSubmit(options.onApply),
    ],
    [
      h.div(
        [h.Class("filter-controls")],
        [
          h.div([h.Class("filter-fields")], [...options.fields]),
          h.div(
            [h.Class("filter-actions")],
            [
              button(h, {
                type: "submit",
                label: "Apply",
                variant: "primary",
                disabled: !options.hasChanges,
              }),
              ...(options.onReset === undefined
                ? []
                : [
                    button(h, {
                      label: "Reset",
                      variant: "ghost",
                      onClick: options.onReset,
                    }),
                  ]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("filter-toolbar")],
        [
          h.div(
            [h.Class("filter-view")],
            [
              h.span([h.Class("filter-view-label")], ["View"]),
              options.viewPicker,
            ],
          ),
          options.saveAction,
        ],
      ),
      ...(options.error
        ? [h.p([h.Role("alert"), h.Class("filter-error")], [options.error])]
        : []),
      ...(options.hasChanges
        ? [
            h.div(
              [h.Class("filter-pending"), h.Role("status")],
              [
                h.span([], ["Unapplied changes"]),
                ...(options.appliedSummary
                  ? [
                      h.div(
                        [h.Class("filter-applied")],
                        [h.span([], ["Showing:"]), options.appliedSummary],
                      ),
                    ]
                  : []),
              ],
            ),
          ]
        : options.notice
          ? [
              h.p(
                [h.Role("status"), h.Class("filter-notice")],
                [options.notice],
              ),
            ]
          : []),
    ],
  );
}
