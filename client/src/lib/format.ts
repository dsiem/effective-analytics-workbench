import { Option, Schema } from "effect";
import { Calendar } from "foldkit";
export { number, compact } from "@dsiem/workbench-ui";
export const money = (value: number, digits = 0) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value);
// Calendar dates deliberately carry neither a time nor a timezone.
export const calendarDay = Schema.decodeUnknownOption(
  Calendar.CalendarDateFromIsoString,
);
export const isoDay = (date: Calendar.CalendarDate) =>
  `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const formatDay = (value: string | undefined) =>
  Option.match(calendarDay(value), {
    onNone: () => "",
    onSome: (date) => dateFormatter.format(new Date(isoDay(date))),
  });

export const dateLabel = (filters: {
  readonly from?: string;
  readonly to?: string;
}) => {
  const from = formatDay(filters.from);
  const to = formatDay(filters.to);
  return from
    ? to
      ? `${from} – ${to}`
      : `From ${from}`
    : to
      ? `Through ${to}`
      : "All dates";
};
