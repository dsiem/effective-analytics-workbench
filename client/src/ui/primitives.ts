import type { Notice } from "../lib/request-state";
import { icon } from "./icons";
import { Button } from "@foldkit/ui";
import type { Attribute, ChildAttribute } from "foldkit/html";
import { card, type Child, type H } from "@dsiem/workbench-ui";
export {
  card,
  metric,
  panelHeader,
  table,
  title,
  type Child,
  type H,
} from "@dsiem/workbench-ui";

export const badge = <Message>(h: H<Message>, text: string) =>
  h.span([h.Class("badge")], [text]);
export interface ButtonOptions<Message> {
  readonly label: Child;
  readonly onClick?: Message;
  readonly type?: "button" | "submit";
  readonly disabled?: boolean;
  /** Suppress activation while retaining keyboard focus during an async action. */
  readonly busy?: boolean;
  readonly variant?: "outline" | "primary" | "ghost" | "destructive";
  readonly size?: "default" | "small" | "icon";
  readonly className?: string;
  readonly attributes?: ReadonlyArray<
    Exclude<Attribute<Message>, { readonly _tag: "Class" }> | ChildAttribute
  >;
}

export const button = <Message>(
  h: H<Message>,
  options: ButtonOptions<Message>,
) =>
  Button.view(
    {
      type: options.type ?? "button",
      ...(options.onClick === undefined ? {} : { onClick: options.onClick }),
      isDisabled: (options.disabled ?? false) || (options.busy ?? false),
      toView: ({ button }) =>
        h.button(
          [
            ...button,
            h.Disabled(options.disabled ?? false),
            ...(options.busy ? [h.AriaBusy(true)] : []),
            ...(options.attributes ?? []),
            h.Class(
              `btn btn-${options.variant ?? "outline"} btn-${options.size ?? "default"} ${options.className ?? ""}`,
            ),
          ],
          [options.label],
        ),
    },
    h,
  );

export const loading = <Message>(h: H<Message>, text = "Loading…") =>
  card(h, [h.p([h.Role("status")], [text])], "loading");
export const error = <Message>(h: H<Message>, text: Notice, retry?: Message) =>
  card(
    h,
    [
      ...(typeof text === "string"
        ? [
            h.h2([], ["Request failed"]),
            h.p([h.Role("alert"), h.Class("muted mt-2")], [text]),
          ]
        : [alert(h, text)]),
      ...(retry
        ? [
            button(h, {
              label: "Try again",
              onClick: retry,
              className: " mt-5",
            }),
          ]
        : []),
    ],
    "p-8",
  );
export const alert = <Message>(h: H<Message>, notice: Notice, detail = "") =>
  typeof notice === "string"
    ? h.p([h.Role("alert"), h.Class("text-sm error-text")], [notice + detail])
    : h.p(
        [h.Role("alert"), h.Class("permission-notice")],
        [icon(h, "lock"), h.span([], [notice.message + detail])],
      );
