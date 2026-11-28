import { Nav, Tooltip } from "@foldkit/ui";
import { Array } from "effect";
import type { ChildAttribute } from "foldkit/html";
import type { Child, H } from "../primitives.js";
import { icon, type IconName } from "./icons.js";
import { button } from "./button.js";
import { dialog } from "./dialog.js";
import * as Layout from "./layout.js";
import * as Theme from "./theme.js";
import { themeSelector } from "./theme-view.js";

export type FrameBrand = {
  readonly name: string;
  readonly description: string;
  readonly href: string;
  readonly icon: IconName;
  readonly ariaLabel?: string;
};
export type FrameLink = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
  readonly current: boolean;
};
export type FrameNavigation = {
  readonly brand: FrameBrand;
  readonly links: readonly FrameLink[];
  readonly current: string;
  readonly navigationLabel?: string;
  readonly user?: { readonly name: string; readonly email?: string | null };
};

export type FrameOptions<M> = FrameNavigation & {
  readonly layout: Layout.Model;
  readonly onLayout: (message: Layout.Message) => M;
  readonly theme: Theme.Model;
  readonly onTheme: (message: Theme.Message) => M;
  readonly controls?: readonly Child[];
  readonly footer?: readonly Child[];
  readonly headerActions?: readonly Child[];
  readonly toolbar?: readonly Child[];
  readonly content: readonly Child[];
  readonly overlays?: readonly Child[];
  readonly contentLandmark?: "main" | "div";
};

function sidebar<M>(h: H<M>, options: FrameOptions<M>) {
  const { layout, user, brand, links, onLayout } = options;
  const initials =
    user?.name
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() ?? "";
  const tooltip = (
    id: string,
    text: string,
    render: (attrs: ChildAttribute[]) => Child,
  ) => {
    if (layout.sidebar || layout.mobile) return render([]);
    return h.submodel({
      slotId: `tooltip-${id}`,
      view: Tooltip.view,
      model: layout.tooltips[id] ?? Layout.initTooltip(id),
      toParentMessage: (message) =>
        onLayout(Layout.Message.GotTooltipMessage({ id, message })),
      viewInputs: {
        anchor: { placement: "right", gap: 8 },
        toView: ({ trigger, panel, isVisible }) =>
          h.div(
            [h.Class("tooltip-anchor")],
            [
              render([...trigger]),
              ...(isVisible
                ? [h.div([...panel, h.Class("tooltip-panel")], [text])]
                : []),
            ],
          ),
      },
    });
  };
  return Nav.view({
    items: links.map((item) => item.href),
    ariaLabel: options.navigationLabel ?? "Main navigation",
    toHref: (href) => href,
    isItemCurrent: (href) =>
      links.some((item) => item.href === href && item.current),
    toView: ({ nav, items }) =>
      h.nav(
        [
          ...nav,
          h.Id("main-navigation"),
          h.Class(
            `sidebar ${!layout.sidebar && !layout.mobile ? "collapsed" : ""}`,
          ),
        ],
        [
          h.a(
            [
              h.Href(brand.href),
              h.Class("sidebar-brand"),
              h.AriaLabel(brand.ariaLabel ?? brand.name),
            ],
            [
              h.span([h.Class("icon-tile")], [icon(h, brand.icon)]),
              h.div(
                [h.Class("sidebar-label")],
                [
                  h.p([h.Class("font-semibold text-sm")], [brand.name]),
                  h.p([h.Class("muted text-xs")], [brand.description]),
                ],
              ),
            ],
          ),
          ...(layout.mobile
            ? [
                button(h, {
                  label: icon(h, "x"),
                  onClick: onLayout(Layout.Message.CloseNavigation()),
                  attributes: [h.AriaLabel("Close navigation")],
                  className: "sidebar-close",
                  size: "icon",
                  variant: "ghost",
                }),
              ]
            : []),
          h.div(
            [h.Class("sidebar-group")],
            [
              h.p(
                [h.Class("sidebar-section-label sidebar-label")],
                ["Workspace"],
              ),
              ...Array.zip(links, items).map(([item, current]) =>
                tooltip(item.id, item.label, (attrs) =>
                  h.a(
                    [
                      ...current.link,
                      h.Class("nav-link"),
                      h.AriaLabel(item.label),
                      ...attrs,
                    ],
                    [
                      h.span([h.Class("nav-icon")], [icon(h, item.icon)]),
                      h.span([h.Class("sidebar-label")], [item.label]),
                    ],
                  ),
                ),
              ),
            ],
          ),
          ...(options.controls ?? []),
          h.div(
            [h.Class("sidebar-bottom")],
            [
              themeSelector(
                h,
                options.theme,
                !layout.sidebar && !layout.mobile,
                options.onTheme,
              ),
              ...(options.footer ?? []),
              ...(user
                ? [
                    tooltip(
                      "profile",
                      `${user.name}${user.email ? ` · ${user.email}` : ""}`,
                      (attrs) =>
                        h.div(
                          [
                            ...attrs,
                            h.Tabindex(0),
                            h.AriaLabel(`Signed in as ${user.name}`),
                            h.Class("profile"),
                          ],
                          [
                            h.span([h.Class("avatar")], [initials]),
                            h.div(
                              [h.Class("sidebar-label min-w-0")],
                              [
                                h.p(
                                  [h.Class("text-sm font-medium truncate")],
                                  [user.name],
                                ),
                                ...(user.email
                                  ? [
                                      h.p(
                                        [h.Class("muted text-xs truncate")],
                                        [user.email],
                                      ),
                                    ]
                                  : []),
                              ],
                            ),
                          ],
                        ),
                    ),
                  ]
                : []),
            ],
          ),
        ],
      ),
  });
}
export function workspaceFrame<M>(h: H<M>, options: FrameOptions<M>) {
  const layout = options.layout;
  const content = options.contentLandmark === "div" ? h.div : h.main;
  return h.div(
    [h.Class("workspace")],
    [
      ...(!layout.mobile ? [sidebar(h, options)] : []),
      h.div(
        [h.Class("workspace-main")],
        [
          h.header(
            [h.Class("workspace-header")],
            [
              button(h, {
                label: icon(h, layout.mobile ? "menu" : "panel-left"),
                onClick: options.onLayout(Layout.Message.ToggleSidebar()),
                attributes: [
                  h.Id("navigation-trigger"),
                  h.AriaLabel(
                    layout.mobile
                      ? layout.mobileNavigation
                        ? "Close navigation"
                        : "Open navigation"
                      : layout.sidebar
                        ? "Collapse sidebar"
                        : "Expand sidebar",
                  ),
                  h.AriaExpanded(
                    layout.mobile ? layout.mobileNavigation : layout.sidebar,
                  ),
                  h.AriaControls("main-navigation"),
                ],
                className: "workspace-navigation",
                size: "icon",
                variant: "ghost",
              }),
              h.nav(
                [h.AriaLabel("Breadcrumb"), h.Class("workspace-path")],
                [
                  h.ol(
                    [],
                    [
                      h.li(
                        [h.Class("workspace-path-parent")],
                        [
                          h.a(
                            [h.Href(options.brand.href)],
                            [options.brand.name],
                          ),
                          icon(h, "chevron-right"),
                        ],
                      ),
                      h.li(
                        [h.Attribute("aria-current", "page")],
                        [options.current],
                      ),
                    ],
                  ),
                ],
              ),
              ...(options.headerActions ?? []),
            ],
          ),
          content(
            [h.Class("workspace-content")],
            [...(options.toolbar ?? []), ...options.content],
          ),
        ],
      ),
      ...(layout.mobile && layout.mobileNavigation
        ? [
            dialog(h, {
              model: layout.navigationDialog,
              onMessage: (message) =>
                options.onLayout(
                  Layout.Message.GotNavigationDialogMessage({ message }),
                ),
              className: "dialog-panel sheet sidebar-dialog",
              accessibleTitle: "Sidebar",
              children: [sidebar(h, options)],
            }),
          ]
        : []),
      ...(options.overlays ?? []),
    ],
  );
}
