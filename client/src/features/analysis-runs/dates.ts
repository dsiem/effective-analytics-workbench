import { DatePicker } from "@foldkit/ui";
import { Option } from "effect";
import { Calendar } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { DatasetMetadata } from "@dsiem/analytics-shared/dataset";
import { calendarDay } from "../../lib/format";
import type { Model, WeekField } from "./model";

export function withMetadata(
  model: Model,
  metadata: typeof DatasetMetadata.Type | null,
  today: Calendar.CalendarDate,
): Model {
  const from = calendarDay(metadata?.from);
  const to = calendarDay(metadata?.to);
  const bounds =
    Option.isSome(from) &&
    Option.isSome(to) &&
    !Calendar.isAfter(from.value, to.value)
      ? { minDate: from.value, maxDate: to.value }
      : {};
  const picker = (field: WeekField) =>
    focusWeek(
      DatePicker.init({ id: `analysis-${field}`, today, ...bounds }),
      model.draft[field],
    );
  return modifyFields(model, {
    datePickers: () =>
      Option.some({
        baselineWeek: picker("baselineWeek"),
        comparisonWeek: picker("comparisonWeek"),
      }),
  });
}

export function focusWeek(
  picker: DatePicker.Model,
  value: string,
): DatePicker.Model {
  const { maybeMinDate, maybeMaxDate } = picker.calendar;
  const date = Option.getOrElse(calendarDay(value), () =>
    Option.getOrElse(maybeMinDate, () => picker.calendar.today),
  );
  return DatePicker.focusDate(
    picker,
    Option.isSome(maybeMinDate) && Option.isSome(maybeMaxDate)
      ? Calendar.clamp(date, {
          minimum: maybeMinDate.value,
          maximum: maybeMaxDate.value,
        })
      : date,
  );
}
