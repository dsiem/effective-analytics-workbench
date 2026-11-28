import { workspaceFrame } from "@dsiem/workbench-ui/workspace-frame";
import { Option } from "effect";
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
import { filterPanel } from "@dsiem/workbench-ui/filters";
import { icon } from "../ui/icons";
import { badge, button, type Child, card, title } from "../ui/primitives";
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

function exploreHeading(h: H, route: AppRoute): Child[] {
  return AppRoute.match<Child[]>(route, {
    Overview: () => [
      title(h, "Trip overview", "Trip activity, fares, and pickup patterns."),
    ],
    Trips: () => [
      title(
        h,
        "Trip records",
        "Inspect individual journeys, fares, and trip comments.",
      ),
    ],
    TripMap: () => [
      title(
        h,
        "Trip hotspots",
        "See where journeys begin and end, beyond ZIP boundaries.",
        [badge(h, "NYC yellow taxis")],
      ),
    ],
    AnalysisRuns: () => [],
    Genie: () => [],
    NotFound: () => [],
  });
}

function filters(h: H, model: Model) {
  const { filters, query } = model.location;
  const applied = Option.getOrUndefined(filters);
  const hasChanges =
    !applied || queryFor(model.filtersState.filterDraft) !== queryFor(applied);
  return filterPanel(h, {
    label: "Filters",
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
    toolbar: [
      h.div(
        [h.Class("filter-view")],
        [
          h.span([h.Class("filter-view-label")], ["View"]),
          h.submodel({
            slotId: "saved-views-picker",
            view: savedViewsView,
            model: model.savedViewsState,
            viewInputs: {
              filters: applied ?? {},
              canSave: !!applied && !hasChanges,
            },
            toParentMessage: Features.savedViews.toParentMessage,
          }),
        ],
      ),
      button(h, {
        label: h.span(
          [h.Class("inline-flex items-center gap-2")],
          [icon(h, "plus"), "Save view"],
        ),
        onClick: Features.savedViews.toParentMessage(
          SavedViewMessage.NewSavedView(),
        ),
        disabled: !applied || hasChanges,
        busy:
          model.savedViewsState.writes.panel._tag === "Preparing" ||
          model.savedViewsState.writes.panel._tag === "Pinning",
        attributes: [
          h.Attribute(
            "title",
            hasChanges
              ? "Apply your changes before saving a view"
              : "Save the applied filters",
          ),
        ],
      }),
    ],
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
    body: workspaceFrame(h, {
      brand: {
        name: "NYC Taxi",
        description: "Analytics workspace",
        href: workspaceHref(pageUrls.Overview, query),
        icon: "car-taxi-front",
        ariaLabel: "NYC Taxi overview",
      },
      current,
      links: navigation.map((item) => ({
        ...item,
        id: item.path,
        href: workspaceHref(item.path, query),
        current: routePath(route) === item.path,
      })),
      layout: model.layout,
      onLayout: Features.layout.toParentMessage,
      theme: model.theme,
      onTheme: Features.theme.toParentMessage,
      ...Option.match(model.user, {
        onNone: () => ({}),
        onSome: (user) => ({ user }),
      }),
      toolbar: explore
        ? [...(applied ? exploreHeading(h, route) : []), filters(h, model)]
        : [],
      content,
      headerActions: explore
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
      overlays: [
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
        ...(model.savedViewsState.writes.panel._tag === "Delete"
          ? [
              h.submodel({
                slotId: "deleteDialog",
                view: deleteDialogView,
                model: model.savedViewsState,
                toParentMessage: Features.savedViews.toParentMessage,
              }),
            ]
          : []),
        ...(model.savedViewsState.writes.panel._tag === "Editor"
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
    }),
  };
}
