import { DatePicker } from "@foldkit/ui";
import { Option, Schema } from "effect";
import type { Filters } from "@dsiem/analytics-shared/filters";
export const FilterDraft = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  zip: Schema.String,
});
export const Model = Schema.Struct({
  filterDraft: FilterDraft,
  error: Schema.String,
  datePickers: Schema.Option(
    Schema.Struct({ from: DatePicker.Model, to: DatePicker.Model }),
  ),
});

export type Model = typeof Model.Type;

export const init = (filters: Filters = {}): Model => ({
  error: "",
  datePickers: Option.none(),
  filterDraft: {
    from: filters.from ?? "",
    to: filters.to ?? "",
    zip: filters.zip ?? "",
  },
});
