import { card, type H } from "@dsiem/workbench-ui";
import { button } from "@dsiem/workbench-ui/workspace-frame";
import type { Notice } from "../lib/request-state";
import { icon } from "./icons";
export {
  button,
  type ButtonOptions,
} from "@dsiem/workbench-ui/workspace-frame";
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
