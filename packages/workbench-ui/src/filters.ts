import { button } from "./frame/button.js";
import type { Child, H } from "./primitives.js";
export { field } from "./field.js";

export function filterPanel<Message>(
  h: H<Message>,
  options: {
    readonly label: string;
    readonly toolbar?: readonly Child[];
    readonly fields: ReadonlyArray<Child>;
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
      ...(options.toolbar?.length
        ? [h.div([h.Class("filter-toolbar")], [...options.toolbar])]
        : []),
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
