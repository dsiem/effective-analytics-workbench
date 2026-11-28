import type { Notice } from "../../lib/request-state";
import { Input, Popover } from "@foldkit/ui";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { SavedView } from "@dsiem/analytics-shared/saved-views";
import { filterSummary } from "../../domain/filter-summary";
import { dateLabel } from "../../lib/format";
import { icon } from "../../ui/icons";
import { alert, button, type Child, error, loading } from "../../ui/primitives";
import { viewOption, viewPicker } from "../../ui/view-picker";
import type { Model } from "./browser-model";
import {
  resultId,
  searchId,
  shortcutGroups,
  visibleSavedViews,
} from "./picker";
import type { H } from "./view-messages";
import { Message as M } from "./view-messages";
import { findingSearch, findingWrite } from "./messages";
import { search, writes } from "./workflow";

type PickerModel = Model & {
  readonly selected: Pick<SavedView, "id" | "title"> | null;
  readonly customFilters: boolean;
  readonly canSave: boolean;
  readonly mutationBusy: boolean;
  readonly canMutate: boolean;
  readonly mutationError: Notice;
};

const moveFocus = (id: string) =>
  Option.some({
    focusSelector: `#${id}`,
    message: M.MovedSavedViewPickerFocus({ id }),
  });

function viewRow(
  h: H,
  model: PickerModel,
  options: {
    readonly savedView: SavedView;
    readonly selected: boolean;
    readonly previous: SavedView | undefined;
    readonly next: SavedView | undefined;
  },
) {
  const { savedView } = options;
  return h.div(
    [h.Key(savedView.id)],
    [
      viewOption(h, {
        title: savedView.title,
        accessibleLabel: `Open saved view for ${savedView.title}`,
        summary: filterSummary(h, savedView.filters),
        description: savedView.body,
        selected: options.selected,
        pinned: savedView.pinned,
        onSelect: M.RestoreView({ savedView }),
        attributes: [
          h.Id(resultId(savedView.id)),
          h.AriaDescription(
            `${dateLabel(savedView.filters)}. Pickup ZIP ${savedView.filters.zip ?? "all areas"}. ${savedView.body}`,
          ),
          h.OnKeyDownFocus((key) => {
            const target =
              key === "ArrowDown"
                ? options.next
                : key === "ArrowUp"
                  ? options.previous
                  : undefined;
            if (key === "ArrowUp" && !options.previous)
              return moveFocus(searchId);
            return target ? moveFocus(resultId(target.id)) : Option.none();
          }),
        ],
        actions: [
          button(h, {
            label: icon(h, savedView.pinned ? "pin" : "pin-off"),
            onClick: findingWrite(writes.Message.Pin({ row: savedView })),
            disabled: !model.canMutate,
            busy: model.mutationBusy,
            size: "icon",
            variant: "ghost",
            attributes: [
              h.AriaLabel(
                `${savedView.pinned ? "Unpin" : "Pin"} ${savedView.title}`,
              ),
            ],
          }),
          button(h, {
            label: icon(h, "pencil"),
            onClick: findingWrite(writes.Message.Edit({ row: savedView })),
            disabled: !model.canMutate,
            size: "icon",
            variant: "ghost",
            attributes: [h.AriaLabel(`Edit ${savedView.title}`)],
          }),
          button(h, {
            label: icon(h, "trash-2"),
            onClick: findingWrite(writes.Message.Delete({ row: savedView })),
            disabled: !model.canMutate,
            size: "icon",
            variant: "ghost",
            attributes: [h.AriaLabel(`Delete ${savedView.title}`)],
          }),
        ],
      }),
    ],
  );
}

function quickViews(h: H, model: PickerModel, renderedRows: Child[]): Child[] {
  if (AsyncData.isPending(model.shortcuts))
    return [loading(h, "Loading pinned and recent views…")];
  const loadError = Option.getOrUndefined(AsyncData.getError(model.shortcuts));
  if (loadError) return [error(h, loadError, M.LoadSavedViewShortcuts())];
  const groups = shortcutGroups(model);
  let offset = 0;
  return groups.length
    ? groups.map((group) => {
        const start = offset;
        offset += group.rows.length;
        return h.div(
          [h.Key(group.title)],
          [
            h.h3([h.Class("view-picker-count")], [group.title]),
            ...renderedRows.slice(start, offset),
          ],
        );
      })
    : [
        h.div(
          [h.Class("view-picker-empty")],
          [
            h.h3([], ["No saved views"]),
            h.p(
              [h.Class("muted text-sm mt-2")],
              ["Save a set of filters to return to it later."],
            ),
          ],
        ),
      ];
}

function matchingViews(
  h: H,
  model: PickerModel,
  renderedRows: Child[],
): Child[] {
  const data = Option.getOrUndefined(AsyncData.getData(model.search.data));
  const busy = AsyncData.isPending(model.search.data);
  const problem = Option.getOrUndefined(AsyncData.getError(model.search.data));
  if (busy && !data) return [loading(h, "Searching saved views…")];
  if (problem && !data)
    return [error(h, problem, findingSearch(search.Message.Refresh()))];
  const rows = data?.rows ?? [];
  return [
    h.p(
      [h.Class("view-picker-count"), h.AriaLive("polite"), h.Role("status")],
      [
        `${rows.length} ${model.pickerMode === "Search" ? "matching " : "saved "}${rows.length === 1 ? "view" : "views"} shown${data?.nextCursor ? " · more available" : ""}`,
      ],
    ),
    ...renderedRows,
    ...(!busy && !problem && !rows.length
      ? [
          h.div(
            [h.Class("view-picker-empty")],
            [
              h.h3([], ["No matching views"]),
              h.p(
                [h.Class("muted text-sm mt-2")],
                ["Try a shorter name, a finding, a date, or a pickup ZIP."],
              ),
              button(h, {
                label: "Clear search",
                onClick: M.ShowSavedViewShortcuts(),
                size: "small",
                className: "mt-3",
              }),
            ],
          ),
        ]
      : []),
    ...(problem ? [alert(h, problem)] : []),
    ...(data?.nextCursor || problem
      ? [
          button(h, {
            label: busy
              ? "Loading views…"
              : problem
                ? "Retry loading views"
                : "Load more views",
            onClick: findingSearch(
              data?.nextCursor
                ? search.Message.More()
                : search.Message.Refresh(),
            ),
            busy,
            attributes: [h.Key("load-saved-views")],
            className: "w-full mt-2",
          }),
        ]
      : []),
  ];
}

export function savedViewBrowser(h: H, model: PickerModel) {
  const selected = model.selected;
  const rows = visibleSavedViews(model);
  const renderedRows = rows.map((savedView, index) =>
    viewRow(h, model, {
      savedView,
      selected: selected?.id === savedView.id,
      previous: rows[index - 1],
      next: rows[index + 1],
    }),
  );
  return viewPicker(h, {
    model: model.picker,
    onMessage: (message) => M.GotSavedViewsPickerMessage({ message }),
    label: "Saved views",
    focusSelector: `#${searchId}`,
    triggerLabel:
      selected?.title ?? (model.customFilters ? "Custom view" : "All trips"),
    children: [
      h.div(
        [h.Class("view-picker-header")],
        [
          h.div(
            [],
            [
              h.h2([], ["Saved views"]),
              h.p(
                [h.Class("muted text-xs mt-1")],
                ["Find a view and apply its filters here."],
              ),
            ],
          ),
          button(h, {
            label: icon(h, "x"),
            onClick: M.GotSavedViewsPickerMessage({
              message: Popover.Message.RequestedClose(),
            }),
            size: "icon",
            variant: "ghost",
            attributes: [h.AriaLabel("Close saved views")],
          }),
        ],
      ),
      h.div(
        [h.Class("view-picker-search")],
        [
          Input.view(
            {
              id: searchId,
              type: "search",
              value: model.search.query,
              placeholder: "Search name, finding, date, or ZIP…",
              onInput: (value) => M.SavedViewSearchChanged({ value }),
              toView: ({ input }) =>
                h.div(
                  [h.Class("view-picker-search-input")],
                  [
                    icon(h, "search"),
                    h.input([
                      ...input,
                      h.Class("input"),
                      h.AriaLabel("Search all saved views"),
                      h.AriaBusy(
                        model.pickerMode === "Quick"
                          ? AsyncData.isPending(model.shortcuts)
                          : AsyncData.isPending(model.search.data),
                      ),
                      h.Maxlength(200),
                      h.Autocomplete("off"),
                      h.AriaDescribedBy("saved-view-search-help"),
                      h.OnKeyDownFocus((key) =>
                        key === "ArrowDown" && rows[0]
                          ? moveFocus(resultId(rows[0].id))
                          : Option.none(),
                      ),
                      h.OnKeyDownPreventDefault((key) =>
                        key === "Enter" && rows[0]
                          ? Option.some(M.RestoreView({ savedView: rows[0] }))
                          : Option.none(),
                      ),
                    ]),
                  ],
                ),
            },
            h,
          ),
          h.p(
            [h.Id("saved-view-search-help"), h.Class("muted text-xs mt-2")],
            ["Search all saved views. ↓ to choose, Enter to apply."],
          ),
        ],
      ),
      h.div(
        [h.Class("view-picker-list")],
        [
          ...(model.pickerMode !== "Search"
            ? [
                viewOption(h, {
                  title: "All trips",
                  accessibleLabel: "Show all trips",
                  summary: h.span(
                    [h.Class("muted text-xs")],
                    ["No filters applied"],
                  ),
                  selected: !model.customFilters && !selected,
                  onSelect: M.ClearView(),
                }),
              ]
            : []),
          ...(model.pickerMode === "Quick"
            ? quickViews(h, model, renderedRows)
            : matchingViews(h, model, renderedRows)),
          ...(model.mutationError ? [alert(h, model.mutationError)] : []),
        ],
      ),
      h.div(
        [h.Class("view-picker-browse")],
        [
          button(h, {
            label:
              model.pickerMode === "Quick"
                ? "Browse all views"
                : "Pinned and recent views",
            onClick:
              model.pickerMode === "Quick"
                ? M.BrowseSavedViews()
                : M.ShowSavedViewShortcuts(),
            size: "small",
            variant: "ghost",
          }),
          h.span([h.Class("muted text-xs")], ["Esc to close"]),
        ],
      ),
      h.div(
        [h.Class("view-picker-footer")],
        [
          h.p(
            [h.Class("muted text-xs")],
            [
              model.canSave
                ? "Saved views are shared with your team."
                : "Apply your changes before saving a view.",
            ],
          ),
          button(h, {
            label: "Save this view",
            onClick: M.NewSavedView(),
            disabled: !model.canSave,
            size: "small",
          }),
        ],
      ),
    ],
  });
}
