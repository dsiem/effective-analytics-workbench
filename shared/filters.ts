import { Schema } from "effect";
import { Day, Zip } from "./schema.js";

const dateOrder = Schema.makeFilter(
  (filters: { readonly from?: string; readonly to?: string }) =>
    !filters.from ||
    !filters.to ||
    filters.from <= filters.to ||
    "The start date must be on or before the end date.",
);

const filterFields = {
  from: Schema.optionalKey(Day),
  to: Schema.optionalKey(Day),
  zip: Schema.optionalKey(Zip),
};

export const filteredSearch = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
) => Schema.Struct({ ...filterFields, ...fields }).check(dateOrder);

export const Filters = filteredSearch({});
export type Filters = typeof Filters.Type;
export const sameFilters = Schema.toEquivalence(Filters);
