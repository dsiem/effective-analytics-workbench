import type { GenieContext } from "@dsiem/analytics-shared/genie";
import type { Filters } from "@dsiem/analytics-shared/filters";
import type { Model } from "./model";
export type ViewModel = Model & {
  readonly mobile: boolean;
  readonly filters: Filters | null;
  readonly context: GenieContext;
};
