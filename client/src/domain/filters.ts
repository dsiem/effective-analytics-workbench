import { Schema, Struct } from "effect";
import { Filters } from "@dsiem/analytics-shared/filters";
export const filtersFromQuery = (query: string | URLSearchParams) => {
  const parsed = Schema.decodeUnknownOption(Filters)(
    Object.fromEntries(
      typeof query === "string" ? new URLSearchParams(query) : query,
    ),
  );
  return parsed._tag === "Some" ? parsed.value : null;
};
export const filterError =
  "Check the dates and five-digit ZIP code. The start date must be on or before the end date.";
const filterKeys = Struct.keys(Filters.fields);
export const queryFor = (filters: Filters) =>
  new URLSearchParams(
    filterKeys.flatMap((key) => {
      const value = filters[key];
      return value ? [[key, value]] : [];
    }),
  ).toString();
export const href = (path: string, query: string) =>
  path + (query ? `?${query}` : "");

export const withSort = (query: string, sort: string, defaultSort: string) => {
  const params = new URLSearchParams(query);
  params.delete("sort");
  if (sort !== defaultSort) params.set("sort", sort);
  return params.toString();
};
