import { DatePicker } from "@foldkit/ui";
import { Option } from "effect";
import { Calendar } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Filters } from "@dsiem/analytics-shared/filters";
import type { DatasetMetadata } from "@dsiem/analytics-shared/dataset";
import { calendarDay } from "../../lib/format";
import { init, type Model } from "./model";

export type Metadata = typeof DatasetMetadata.Type | null;

function viewDate(
  field: "from" | "to",
  value: string,
  range: { minimum: Calendar.CalendarDate; maximum: Calendar.CalendarDate },
) {
  const date = Option.getOrElse(calendarDay(value), () =>
    field === "from" ? range.minimum : range.maximum,
  );
  return Calendar.clamp(date, range);
}

function limits(metadata: Metadata, draft: Model["filterDraft"]) {
  const from = calendarDay(metadata?.from);
  const to = calendarDay(metadata?.to);
  if (
    Option.isNone(from) ||
    Option.isNone(to) ||
    Calendar.isAfter(from.value, to.value)
  )
    return null;
  const minimum = from.value;
  const maximum = to.value;
  const clamp = Calendar.clamp({ minimum, maximum });
  return {
    from: {
      minimum,
      maximum: Option.match(calendarDay(draft.to), {
        onNone: () => maximum,
        onSome: clamp,
      }),
    },
    to: {
      minimum: Option.match(calendarDay(draft.from), {
        onNone: () => minimum,
        onSome: clamp,
      }),
      maximum,
    },
  };
}

/** Bounds come from the dataset; an empty field views its valid range, never today. */
export function withMetadata(
  model: Model,
  metadata: Metadata,
  today: Calendar.CalendarDate,
): Model {
  const bounds = limits(metadata, model.filterDraft);
  if (!bounds) return modifyFields(model, { datePickers: Option.none });
  const picker = (field: "from" | "to") => {
    const range = bounds[field];
    return DatePicker.init({
      id: `pickup-${field}-calendar`,
      today,
      minDate: range.minimum,
      maxDate: range.maximum,
      initialViewDate: viewDate(field, model.filterDraft[field], range),
    });
  };
  return modifyFields(model, {
    datePickers: () => Option.some({ from: picker("from"), to: picker("to") }),
  });
}

/** Reopening always starts at the selection or a valid range boundary. */
export function focusOnOpen(
  picker: DatePicker.Model,
  field: "from" | "to",
  value: string,
): DatePicker.Model {
  const minimum = picker.calendar.maybeMinDate;
  const maximum = picker.calendar.maybeMaxDate;
  if (Option.isNone(minimum) || Option.isNone(maximum)) return picker;
  return DatePicker.focusDate(
    picker,
    viewDate(field, value, { minimum: minimum.value, maximum: maximum.value }),
  );
}

export function reset(
  model: Model,
  filters: Filters,
  metadata: Metadata,
): Model {
  const fresh = init(filters);
  return Option.match(model.datePickers, {
    onNone: () => fresh,
    onSome: ({ from }) => withMetadata(fresh, metadata, from.calendar.today),
  });
}

/** Reflect a typed edit or calendar selection into both pickers' constraints. */
export function syncDates(
  model: Model,
  metadata: Metadata,
  edited: "from" | "to" | "zip",
): Model {
  const bounds = limits(metadata, model.filterDraft);
  const pickers = model.datePickers;
  if (!bounds || Option.isNone(pickers)) return model;
  const reflect = (field: "from" | "to") => {
    const range = bounds[field];
    let picker = DatePicker.reflectMaxDate(
      DatePicker.reflectMinDate(
        pickers.value[field],
        Option.some(range.minimum),
      ),
      Option.some(range.maximum),
    );
    const selected = calendarDay(model.filterDraft[field]);
    if (edited === field && Option.isSome(selected))
      picker = DatePicker.focusDate(
        picker,
        Calendar.clamp(selected.value, range),
      );
    return picker;
  };
  return modifyFields(model, {
    datePickers: () =>
      Option.some({ from: reflect("from"), to: reflect("to") }),
  });
}
