import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { dateField } from "../../ui/date-field";
import { dialog } from "../../ui/dialog";
import { field } from "@dsiem/workbench-ui/filters";
import { alert, button, type H } from "../../ui/primitives";
import { Message as M, type Message } from "./messages";
import type { Model, WeekField } from "./model";

export function analysisForm(h: H<Message>, model: Model) {
  const busy = model.submission._tag === "Submitting";
  const week = (
    key: WeekField,
    id: string,
    label: string,
    calendarLabel: string,
  ) =>
    dateField(h, {
      id,
      label,
      calendarLabel,
      value: model.draft[key],
      model: Option.map(model.datePickers, (pickers) => pickers[key]),
      onInput: (value) => M.AnalysisFieldChanged({ field: key, value }),
      onMessage: (message) =>
        M.GotAnalysisDatePickerMessage({ id: key, message }),
    });

  return dialog(h, {
    model: model.dialog,
    onMessage: (message) => M.GotAnalysisFormDialogMessage({ message }),
    className: "dialog-panel analysis-dialog",
    children: [
      h.div(
        [h.Class("dialog-header")],
        [
          h.h2([h.Id(Dialog.titleId(model.dialog))], ["New analysis run"]),
          h.p(
            [h.Class("muted text-sm mt-2")],
            ["Compare route travel times across two seven-day windows."],
          ),
        ],
      ),
      h.form(
        [h.Novalidate(true), h.OnSubmit(M.StartAnalysis())],
        [
          h.fieldset(
            [h.Class("analysis-form-fields"), h.Disabled(busy)],
            [
              week(
                "baselineWeek",
                "analysis-baseline-week",
                "Baseline week starts",
                "Choose baseline week start",
              ),
              week(
                "comparisonWeek",
                "analysis-comparison-week",
                "Comparison week starts",
                "Choose comparison week start",
              ),
              field(h, {
                id: "analysis-minimum-trips",
                label: "Minimum trips per week",
                type: "number",
                value: model.draft.minimumTrips,
                onInput: (value) =>
                  M.AnalysisFieldChanged({ field: "minimumTrips", value }),
                attributes: [h.Min("1"), h.Step("1"), h.Required(true)],
              }),
            ],
          ),
          ...(!busy && model.submission.error
            ? [
                h.div(
                  [h.Class("analysis-panel-body")],
                  [alert(h, model.submission.error)],
                ),
              ]
            : []),
          h.div(
            [h.Class("dialog-footer")],
            [
              button(h, {
                label: "Cancel",
                onClick: M.CloseAnalysisForm(),
                disabled: busy,
              }),
              button(h, {
                label: busy
                  ? "Starting…"
                  : Option.isSome(model.submission.retryId)
                    ? "Retry submission"
                    : "Run analysis",
                type: "submit",
                variant: "primary",
                disabled: busy,
              }),
            ],
          ),
        ],
      ),
    ],
  });
}
