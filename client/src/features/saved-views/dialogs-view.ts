import { Dialog } from "@foldkit/ui";
import { findingFields } from "@dsiem/workbench-ui/findings";
import { Option } from "effect";
import { defineView } from "foldkit/submodel";
import { filterSummary } from "../../domain/filter-summary";
import { dialog } from "../../ui/dialog";
import { icon } from "../../ui/icons";
import { alert, button } from "../../ui/primitives";
import type { Model } from "./model";
import { type H, Message as M } from "./view-messages";

const close = (h: H, label = "Close") =>
  button(h, {
    label: icon(h, "x"),
    onClick: M.CloseSavedView(),
    attributes: [h.AriaLabel(label)],
    className: " dialog-close",
    variant: "ghost",
  });
function editor(h: H, model: Model) {
  const editor = Option.getOrUndefined(model.editor);
  if (!editor) return null;
  const { draft, saving } = editor;
  const name =
    draft.version === null
      ? "What would you call this view?"
      : "Edit saved view";
  return dialog(h, {
    model: model.dialogs.savedView,
    onMessage: (message) => M.GotSavedViewDialogMessage({ message }),
    className: "dialog-panel overflow-y-auto",
    children: [
      close(h),
      h.div(
        [h.Class("dialog-header")],
        [
          h.h2([h.Id(Dialog.titleId(model.dialogs.savedView))], [name]),
          ...(draft.version !== null
            ? [
                h.p(
                  [h.Class("muted text-sm mt-2")],
                  ["Update the name or finding for your team."],
                ),
              ]
            : []),
        ],
      ),
      h.form(
        [h.OnSubmit(M.SaveSavedView()), h.Class("p-6 space-y-5")],
        [
          ...findingFields(h, {
            id: "saved-view",
            title: draft.title,
            body: draft.body,
            readOnly: saving,
            titleLabel: "View name",
            bodyLabel: "Finding (optional)",
            titlePlaceholder: "e.g. Midtown fare review",
            bodyPlaceholder:
              "What is worth returning to? Add context or a next step…",
            onChange: (field, value) => M.SavedViewChanged({ field, value }),
          }),
          h.div(
            [h.Class("inset-panel")],
            [
              h.p([h.Class("text-sm font-medium mb-2")], ["Applied filters"]),
              filterSummary(h, draft.filters),
              h.p(
                [h.Class("muted text-xs leading-5 mt-3")],
                [
                  draft.version !== null
                    ? "This saved view keeps its original filters, even when your Explore view changes."
                    : "Saved views store global pickup dates and ZIP. Reopening a view resets trip sorting to latest pickup.",
                ],
              ),
            ],
          ),
          ...(editor.error ? [alert(h, editor.error)] : []),
          h.div(
            [h.Class("flex justify-end gap-2")],
            [
              button(h, {
                label: "Cancel",
                onClick: M.CloseSavedView(),
                disabled: saving,
              }),
              button(h, {
                type: "submit",
                label: saving ? "Saving…" : "Save view",
                disabled: saving || !draft.title.trim(),
                variant: "primary",
              }),
            ],
          ),
        ],
      ),
    ],
  });
}
function deleteDialog(h: H, model: Model) {
  return dialog(h, {
    model: model.dialogs.delete,
    onMessage: (message) => M.GotDeleteDialogMessage({ message }),
    className: "dialog-panel overflow-y-auto",
    children: [
      h.div(
        [h.Class("dialog-header")],
        [
          h.h2(
            [h.Id(Dialog.titleId(model.dialogs.delete))],
            ["Delete this saved view?"],
          ),
          h.p(
            [h.Class("muted text-sm mt-2")],
            [
              `“${Option.getOrUndefined(model.deleting)?.title ?? ""}” will be removed from saved views.`,
            ],
          ),
        ],
      ),
      ...(model.savedViewError ? [alert(h, model.savedViewError)] : []),
      h.div(
        [h.Class("dialog-footer")],
        [
          button(h, {
            label: "Cancel",
            onClick: M.CloseDelete(),
            disabled: model.savedViewBusy,
          }),
          button(h, {
            label: model.savedViewBusy ? "Deleting…" : "Delete view",
            onClick: M.ConfirmDelete(),
            disabled: model.savedViewBusy,
            variant: "destructive",
          }),
        ],
      ),
    ],
  });
}

export const editorView = defineView<Model, typeof M.Type>((model, h) =>
  editor(h, model),
);

export const deleteDialogView = defineView<Model, typeof M.Type>((model, h) =>
  deleteDialog(h, model),
);
