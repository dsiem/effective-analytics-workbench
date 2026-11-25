import { childAttributes, inertHtml } from "foldkit/html";
import { icon } from "../ui/icons";
import * as Features from "./features";
import type { Model } from "./model";
import { Message, ThemeMenu, ThemePreference } from "./theme";
import type { H } from "./view-types";

const icons = { Dark: "moon", Light: "sun", System: "monitor" } as const;

// Follow Foldkit's own theme selector: a Menu submodel owns focus and dismissal.
export const themeSelector = (h: H, model: Model) => {
  const collapsed = !model.layout.sidebar && !model.layout.mobile;
  return h.submodel({
    slotId: "theme-menu",
    model: model.theme.menu,
    view: ThemeMenu.view,
    toParentMessage: (message) =>
      Features.theme.toParentMessage(Message.GotThemeMenuMessage({ message })),
    viewInputs: {
      ariaLabel: `Theme: ${model.theme.preference}`,
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
          icon(h, icons[model.theme.preference]),
          h.span([h.Class("sidebar-label")], ["Appearance"]),
          h.span(
            [h.Class("appearance-value sidebar-label")],
            [model.theme.preference],
          ),
          h.span(
            [h.Class("appearance-chevron sidebar-label")],
            [icon(h, "chevron-down")],
          ),
        ],
      ),
      buttonClassName: "btn btn-ghost appearance-trigger",
      buttonAttributes: childAttributes([
        inertHtml.Attribute("title", `Appearance: ${model.theme.preference}`),
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
            ...(preference === model.theme.preference
              ? [icon(h, "check"), h.span([h.Class("sr-only")], ["(selected)"])]
              : []),
          ],
        ),
      }),
    },
  });
};
