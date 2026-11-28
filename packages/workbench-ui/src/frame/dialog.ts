import { Dialog } from "@foldkit/ui";
import type { Child, H } from "../primitives.js";
export function dialog<Message>(
  h: H<Message>,
  options: {
    readonly model: Dialog.Model;
    readonly onMessage: (message: Dialog.Message) => Message;
    readonly className: string;
    readonly children: Child[];
    readonly accessibleTitle?: string;
  },
) {
  return h.submodel({
    slotId: `dialog-${options.model.id}`,
    view: Dialog.view,
    model: options.model,
    toParentMessage: options.onMessage,
    viewInputs: {
      toView: ({ dialog, backdrop, panel, title, isVisible }) =>
        h.dialog(
          [...dialog, h.Class("modal-host")],
          isVisible
            ? [
                h.div([...backdrop, h.Class("modal-backdrop")], []),
                h.div(
                  [...panel, h.Class(options.className)],
                  [
                    ...(options.accessibleTitle
                      ? [
                          h.h2(
                            [...title, h.Class("sr-only")],
                            [options.accessibleTitle],
                          ),
                        ]
                      : []),
                    ...options.children,
                  ],
                ),
              ]
            : [],
        ),
    },
  });
}
