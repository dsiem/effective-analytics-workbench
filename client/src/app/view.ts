import { Nav, Tooltip } from "@foldkit/ui";
import { Array, Option } from "effect";
import type { Document } from "foldkit/html";
import { filterSummary } from "../domain/filter-summary";
import { filterError, href, queryFor } from "../domain/filters";
import { analysisRunsView } from "../features/analysis-runs/view";
import { Message as FilterMessage } from "../features/filters/messages";
import { filterFields } from "../features/filters/view";
import { genieHelperView, genieView } from "../features/genie/view";
import { gpsMapView } from "../features/gps/view";
import { overviewView } from "../features/overview/view";
import {
  deleteDialogView,
  editorView,
} from "../features/saved-views/dialogs-view";
import { Message as SavedViewMessage } from "../features/saved-views/messages";
import { savedViewsView } from "../features/saved-views/view";
import { inspectorView } from "../features/trips/inspector";
import { tripsView } from "../features/trips/view";
import { dialog } from "../ui/dialog";
import { filterPanel } from "../ui/filter-panel";
import { icon } from "../ui/icons";
import { button, type Child, card } from "../ui/primitives";
import { pageContext } from "./analysis-context";
import * as Features from "./features";
import { type Model, navigation } from "./model";
import {
  AppRoute,
  pageUrls,
  routePath,
  showsExplore,
  withoutRun,
} from "./route";
import { themeSelector } from "./theme-view";
import { initTooltip, Message as LayoutMessage } from "./layout";
import {
  openGenie,
  overviewViewMessage,
  gpsViewMessage,
  tripsViewMessage,
} from "./view-messages";
import type { H } from "./view-types";

function workspaceHref(path: string, query: string) {
  return href(path, withoutRun(query));
}

function sidebar(h: H, model: Model) {
  const { route, query } = model.location;
  const user = Option.getOrUndefined(model.user);
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
    render: (attrs: import("foldkit/html").ChildAttribute[]) => Child,
  ) => {
    if (model.layout.sidebar || model.layout.mobile) return render([]);
    return h.submodel({
      slotId: `tooltip-${id}`,
      view: Tooltip.view,
      model: model.layout.tooltips[id] ?? initTooltip(id),
      toParentMessage: (message) =>
        Features.layout.toParentMessage(
          LayoutMessage.GotTooltipMessage({ id, message }),
        ),
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
    items: navigation.map((item) => item.path),
    ariaLabel: "Main navigation",
    toHref: (path) => workspaceHref(path, query),
    isItemCurrent: (path) => routePath(route) === path,
    toView: ({ nav, items }) =>
      h.nav(
        [
          ...nav,
          h.Id("main-navigation"),
          h.Class(
            `sidebar ${!model.layout.sidebar && !model.layout.mobile ? "collapsed" : ""}`,
          ),
        ],
        [
          h.a(
            [
              h.Href(workspaceHref(pageUrls.Overview, query)),
              h.Class("sidebar-brand"),
            ],
            [
              h.span([h.Class("icon-tile")], [icon(h, "car-taxi-front")]),
              h.div(
                [h.Class("sidebar-label")],
                [
                  h.p([h.Class("font-semibold text-sm")], ["NYC Taxi"]),
                  h.p([h.Class("muted text-xs")], ["Analytics workspace"]),
                ],
              ),
            ],
          ),
          ...(model.layout.mobile
            ? [
                button(h, {
                  label: icon(h, "x"),
                  onClick: Features.layout.toParentMessage(
                    LayoutMessage.CloseNavigation(),
                  ),
                  attributes: [h.AriaLabel("Close navigation")],
                  className: " absolute right-2 top-4",
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
              ...Array.zip(navigation, items).map(([item, current]) =>
                tooltip(item.path, item.label, (attrs) =>
                  h.a(
                    [
                      ...current.link,
                      h.Class(`nav-link ${current.isCurrent ? "active" : ""}`),
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
          h.div(
            [h.Class("sidebar-bottom")],
            [
              themeSelector(h, model),
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
function filters(h: H, model: Model) {
  const { filters, query } = model.location;
  const applied = Option.getOrUndefined(filters);
  const hasChanges =
    !applied || queryFor(model.filtersState.filterDraft) !== queryFor(applied);
  return filterPanel(h, {
    label: "Filters",
    viewPicker: h.submodel({
      slotId: "saved-views-picker",
      view: savedViewsView,
      model: model.savedViewsState,
      viewInputs: {
        filters: applied ?? {},
        canSave: !!applied && !hasChanges,
      },
      toParentMessage: Features.savedViews.toParentMessage,
    }),
    fields: filterFields(h, {
      draft: model.filtersState.filterDraft,
      datePickers: model.filtersState.datePickers,
      onDateMessage: (field, message) =>
        Features.filters.toParentMessage(
          FilterMessage.GotFilterDatePickerMessage({ id: field, message }),
        ),
      onChange: (field, value) =>
        Features.filters.toParentMessage(
          FilterMessage.FilterChanged({ field, value }),
        ),
    }),
    saveAction: button(h, {
      label: h.span(
        [h.Class("inline-flex items-center gap-2")],
        [icon(h, "plus"), "Save view"],
      ),
      onClick: Features.savedViews.toParentMessage(
        SavedViewMessage.NewSavedView(),
      ),
      disabled: !applied || hasChanges,
      attributes: [
        h.Attribute(
          "title",
          hasChanges
            ? "Apply your changes before saving a view"
            : "Save the applied filters",
        ),
      ],
    }),
    onApply: Features.filters.toParentMessage(FilterMessage.ApplyFilters()),
    ...(query || hasChanges
      ? {
          onReset: Features.filters.toParentMessage(
            FilterMessage.ResetFilters(),
          ),
        }
      : {}),
    hasChanges,
    ...(applied ? { appliedSummary: filterSummary(h, applied) } : {}),
    error: model.filtersState.error,
    notice: model.savedViewsState.notice,
  });
}
export function view(model: Model, h: H): Document {
  const { route, query, filters: appliedFilters } = model.location;
  const applied = Option.getOrNull(appliedFilters);
  const explore = showsExplore(route);
  const content =
    route._tag !== "AnalysisRuns" && !applied
      ? [
          card(
            h,
            [
              h.h1(
                [h.Class("text-lg font-semibold")],
                ["Invalid Explore filters"],
              ),
              h.p([h.Class("muted text-sm mt-3 mb-5")], [filterError]),
              button(h, {
                label: "Clear invalid filters",
                onClick: Features.filters.toParentMessage(
                  FilterMessage.ResetFilters(),
                ),
              }),
            ],
            "p-8",
          ),
        ].map((child) => h.div([h.Role("alert")], [child]))
      : AppRoute.match<Child[]>(route, {
          Overview: () => [
            h.submodel({
              slotId: "overview",
              view: overviewView,
              model: model.overviewState,
              viewInputs: {
                query,
                filters: applied ?? {},
                mobile: model.layout.mobile,
              },
              toParentMessage: overviewViewMessage,
            }),
          ],
          Trips: ({ sort }) => [
            h.submodel({
              slotId: "trips",
              view: tripsView,
              model: model.tripsState,
              viewInputs: { sort, mobile: model.layout.mobile },
              toParentMessage: tripsViewMessage,
            }),
          ],
          TripMap: () => [
            h.submodel({
              slotId: "gpsMap",
              view: gpsMapView,
              model: model.gpsState,
              viewInputs: { query, filters: applied ?? {} },
              toParentMessage: gpsViewMessage,
            }),
          ],
          AnalysisRuns: () => [
            h.submodel({
              slotId: "analysis-runs",
              view: analysisRunsView,
              model: model.analysisRunsState,
              viewInputs: { query },
              toParentMessage: Features.analysisRuns.toParentMessage,
            }),
          ],
          Genie: () => [
            h.submodel({
              slotId: "genie",
              view: genieView,
              model: model.genieState,
              viewInputs: {
                context: pageContext(model),
                mobile: model.layout.mobile,
                filters: applied,
              },
              toParentMessage: Features.genie.toParentMessage,
            }),
          ],
          NotFound: () => [
            h.p(
              [h.Class("text-center py-20")],
              [
                "Page not found. ",
                h.a(
                  [h.Href(pageUrls.Overview), h.Class("underline")],
                  ["Back to overview"],
                ),
              ],
            ),
          ],
        });
  const current =
    navigation.find((item) => item.path === routePath(route))?.label ??
    (route._tag === "Genie" ? "Ask Genie" : "Workspace");
  return {
    title:
      route._tag === "AnalysisRuns" && route.run._tag === "SelectedRun"
        ? `NYC Taxi · Run #${route.run.id} · ${current}`
        : `NYC Taxi · ${current}`,
    body: h.div(
      [h.Class("workspace")],
      [
        ...(!model.layout.mobile ? [sidebar(h, model)] : []),
        h.div(
          [h.Class("workspace-main")],
          [
            h.header(
              [h.Class("workspace-header")],
              [
                button(h, {
                  label: icon(h, model.layout.mobile ? "menu" : "panel-left"),
                  onClick: Features.layout.toParentMessage(
                    LayoutMessage.ToggleSidebar(),
                  ),
                  attributes: [
                    h.Id("navigation-trigger"),
                    h.AriaLabel(
                      model.layout.mobile
                        ? model.layout.mobileNavigation
                          ? "Close navigation"
                          : "Open navigation"
                        : model.layout.sidebar
                          ? "Collapse sidebar"
                          : "Expand sidebar",
                    ),
                    h.AriaExpanded(
                      model.layout.mobile
                        ? model.layout.mobileNavigation
                        : model.layout.sidebar,
                    ),
                    h.AriaControls("main-navigation"),
                  ],
                  variant: "ghost",
                }),
                h.span([h.Class("h-4 border-l mx-2")], []),
                h.a(
                  [
                    h.Href(workspaceHref(pageUrls.Overview, query)),
                    h.Class("hidden sm:block muted text-sm"),
                  ],
                  ["NYC Taxi"],
                ),
                h.span([h.Class("hidden sm:block muted text-sm")], ["/ "]),
                h.span([h.Class("text-sm")], [current]),
                h.div(
                  [h.Class("ml-auto flex items-center gap-2")],
                  explore
                    ? [
                        button(h, {
                          label: h.span(
                            [h.Class("inline-flex items-center gap-2")],
                            [icon(h, "sparkles"), "Ask Genie"],
                          ),
                          onClick: openGenie({ context: null, question: null }),
                          disabled: !applied,
                          attributes: [h.Id("genie-trigger")],
                        }),
                      ]
                    : [],
                ),
              ],
            ),
            h.main(
              [h.Class("workspace-content")],
              [...(explore ? [filters(h, model)] : []), ...content],
            ),
          ],
        ),
        ...(model.genieState.genieOpen && explore
          ? [
              h.submodel({
                slotId: "genie-helper",
                view: genieHelperView,
                model: model.genieState,
                viewInputs: {
                  context: pageContext(model),
                  mobile: model.layout.mobile,
                  filters: applied,
                },
                toParentMessage: Features.genie.toParentMessage,
              }),
            ]
          : []),
        ...(model.layout.mobile && model.layout.mobileNavigation
          ? [
              dialog(h, {
                model: model.layout.navigationDialog,
                onMessage: (message) =>
                  Features.layout.toParentMessage(
                    LayoutMessage.GotNavigationDialogMessage({ message }),
                  ),
                className: "dialog-panel sheet sidebar-dialog",
                accessibleTitle: "Sidebar",
                children: [sidebar(h, model)],
              }),
            ]
          : []),
        ...(Option.isSome(model.tripsState.inspector)
          ? [
              h.submodel({
                slotId: "inspector",
                view: inspectorView,
                model: {
                  ...model.tripsState,
                },
                toParentMessage: Features.trips.toParentMessage,
              }),
            ]
          : []),
        ...(Option.isSome(model.savedViewsState.deleting)
          ? [
              h.submodel({
                slotId: "deleteDialog",
                view: deleteDialogView,
                model: model.savedViewsState,
                toParentMessage: Features.savedViews.toParentMessage,
              }),
            ]
          : []),
        ...(Option.isSome(model.savedViewsState.editor)
          ? [
              h.submodel({
                slotId: "editor",
                view: editorView,
                model: model.savedViewsState,
                toParentMessage: Features.savedViews.toParentMessage,
              }),
            ]
          : []),
      ],
    ),
  };
}
