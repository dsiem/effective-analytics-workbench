import type { DatePicker } from "@foldkit/ui";
import { Option } from "effect";
import { dateField } from "../../ui/date-field";
import { field } from "@dsiem/workbench-ui/filters";
import type { H } from "../../ui/primitives";
import type { Model } from "./model";

/** Taxi sample controls. Other datasets replace this composition, not the panel. */
export function filterFields<Message>(
  h: H<Message>,
  options: {
    readonly draft: Model["filterDraft"];
    readonly datePickers: Model["datePickers"];
    readonly onDateMessage: (
      field: "from" | "to",
      message: DatePicker.Message,
    ) => Message;
    readonly onChange: (
      field: keyof Model["filterDraft"],
      value: string,
    ) => Message;
  },
) {
  return [
    ...(
      [
        ["from", "Pickup start date"],
        ["to", "Pickup end date"],
      ] as const
    ).map(([key, label]) =>
      dateField(h, {
        calendarLabel: key === "from" ? "Choose start date" : "Choose end date",
        id: `pickup-${key}`,
        label,
        value: options.draft[key],
        model: Option.map(options.datePickers, (pickers) => pickers[key]),
        onInput: (value) => options.onChange(key, value),
        onMessage: (message) => options.onDateMessage(key, message),
      }),
    ),
    field(h, {
      id: "pickup-zip",
      label: "Pickup ZIP code",
      value: options.draft.zip,
      placeholder: "All pickup areas",
      onInput: (value) => options.onChange("zip", value),
      attributes: [
        h.InputMode("numeric"),
        h.Pattern("[0-9]{5}"),
        h.Maxlength(5),
      ],
    }),
  ];
}
