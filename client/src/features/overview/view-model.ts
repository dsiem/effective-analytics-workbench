import type { Filters } from "@dsiem/analytics-shared/filters";
import type { Model } from "./model";
export type ViewModel = Model & {
  readonly query: string;
  readonly filters: Filters;
  readonly mobile: boolean;
};
