import { childAttributes, inertHtml } from "foldkit/html";
import { icon } from "./icons.js";
import type { H } from "../primitives.js";
import * as Theme from "./theme.js";
import { ThemeMenu, ThemePreference } from "./theme.js";

const icons = { Dark: "moon", Light: "sun", System: "monitor" } as const;

// Follow Foldkit's own theme selector: a Menu submodel owns focus and dismissal.
export const themeSelector = <M>(
  h: H<M>,
  theme: Theme.Model,
  collapsed: boolean,
  onMessage: (message: Theme.Message) => M,
) => {
  return h.submodel({
    slotId: "theme-menu",
    model: theme.menu,
    view: ThemeMenu.view,
    toParentMessage: (message) =>
      onMessage(Theme.Message.GotThemeMenuMessage({ message })),
    viewInputs: {
      ariaLabel: `Theme: ${theme.preference}`,
      items: ThemePreference.literals,
      anchor: {
        placement: collapsed ? "right-end" : "top-start",
        // Clear the compact button's 12px inset from the sidebar edge.
        gap: collapsed ? 20 : 8,
        padding: 8,
      },
      buttonContent: h.span(
        [h.Class("appearance-content")],
        [
          icon(h, icons[theme.preference]),
          h.span([h.Class("sidebar-label")], ["Appearance"]),
          h.span(
            [h.Class("appearance-value sidebar-label")],
            [theme.preference],
          ),
          h.span(
            [h.Class("appearance-chevron sidebar-label")],
            [icon(h, "chevron-down")],
          ),
        ],
      ),
      buttonClassName: "btn btn-ghost appearance-trigger",
      buttonAttributes: childAttributes([
        inertHtml.Attribute("title", `Appearance: ${theme.preference}`),
      ]),
      itemsClassName: "action-menu",
      backdropClassName: "action-menu-backdrop",
      className: "appearance-selector",
      itemToConfig: (preference) => ({
        className: "action-menu-option",
        content: h.div(
          [h.Class("flex items-center gap-3 w-full")],
          [
            icon(h, icons[preference]),
            h.span([h.Class("flex-1")], [preference]),
            ...(preference === theme.preference
              ? [icon(h, "check"), h.span([h.Class("sr-only")], ["(selected)"])]
              : []),
          ],
        ),
      }),
    },
  });
};
